import { notFound, redirect } from "next/navigation";
import {
  RolePlayPreview,
  type OrganizationUser,
  type RolePlayData,
} from "@/components/role-play-preview";
import { ScenarioOverview, type ScenarioOverviewData } from "@/components/scenario-overview";
import { db } from "@/lib/db";
import { getTrainerOrg, type TrainerOrg } from "@/lib/org";
import { getStoredRoleplay } from "@/lib/roleplay";
import { isSessionReport } from "@/lib/session-report";
import { readSpecDraft } from "@/lib/spec-drafts";
import { agentDisplayName, readSpec } from "@/lib/specs";

export const dynamic = "force-dynamic";

export default async function RolePlayPreviewPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const org = await getTrainerOrg();
  if (!org) redirect("/auth/no-org");

  const [current, draft, members, assignments] = await Promise.all([
    readSpec("agents", slug, org.id).catch(() => null),
    readSpecDraft(slug, org.id).catch(() => null),
    db.member.findMany({
      where: { organizationId: org.id, role: "member" },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        user: { select: { name: true, email: true } },
      },
    }),
    db.rolePlayAssignment.findMany({
      where: { orgId: org.id, deployment: { agent: { slug } } },
      orderBy: { assignedAt: "desc" },
      select: {
        id: true,
        status: true,
        assignedAt: true,
        expiresAt: true,
        recipientEmail: true,
        member: { select: { user: { select: { name: true, email: true } } } },
      },
    }),
  ]);

  const assignmentSummaries = assignments.map(({ id, status, assignedAt, expiresAt, recipientEmail, member }) => ({
    id,
    status,
    assignedAt: assignedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    userName: member?.user.name || recipientEmail,
    userEmail: recipientEmail,
  }));

  const availableUsers: OrganizationUser[] = members.map((member) => ({
    id: member.id,
    name: member.user.name || "Unnamed User",
    email: member.user.email,
  }));

  let rolePlay: RolePlayData | null = null;

  if (current) {
    const doc = current.doc as Record<string, unknown>;
    const rawStages = Array.isArray(doc.stages) ? doc.stages : [];
    const config = (typeof doc.config === "object" && doc.config !== null
      ? doc.config
      : {}) as RolePlayData["config"];

    let voiceName: string | undefined;
    if (typeof doc.voiceId === "string" && doc.voiceId) {
      const voice = await db.voice.findFirst({
        where: { id: doc.voiceId, OR: [{ orgId: org.id }, { orgId: null }] },
        select: { name: true },
      });
      voiceName = voice?.name;
    }

    let knowledgeBaseName: string | undefined;
    if (typeof doc.knowledgeBase === "string" && doc.knowledgeBase) {
      const kb = await db.knowledgeBase.findFirst({
        where: { slug: doc.knowledgeBase, orgId: org.id },
        select: { name: true },
      });
      knowledgeBaseName = kb?.name;
    }

    rolePlay = {
      slug,
      name: agentDisplayName(slug, typeof doc.name === "string" ? doc.name : slug),
      objective: typeof doc.objective === "string" ? doc.objective : undefined,
      instruction: typeof doc.instruction === "string" ? doc.instruction : undefined,
      opening: typeof doc.opening === "string" ? doc.opening : undefined,
      voiceId: typeof doc.voiceId === "string" ? doc.voiceId : undefined,
      voiceName,
      knowledgeBase:
        typeof doc.knowledgeBase === "string" ? doc.knowledgeBase : undefined,
      knowledgeBaseName,
      status: "published",
      version: current.version,
      draftRevision: draft?.status === "draft" ? draft.revision : undefined,
      stages: rawStages as RolePlayData["stages"],
      config,
    };
  } else {
    if (!draft) notFound();

    const agent = draft.agent as Record<string, unknown>;
    const rawStages = Array.isArray(agent?.stages) ? agent.stages : [];

    rolePlay = {
      slug: draft.slug,
      name: agentDisplayName(draft.slug, draft.name),
      objective: typeof agent?.objective === "string" ? agent.objective : undefined,
      instruction: typeof agent?.instruction === "string" ? agent.instruction : undefined,
      opening: typeof agent?.opening === "string" ? agent.opening : undefined,
      status: "draft",
      version: draft.revision,
      stages: rawStages as RolePlayData["stages"],
      config: (typeof agent?.config === "object" && agent?.config !== null
        ? agent.config
        : {}) as RolePlayData["config"],
    };
  }

  const overviewData = current ? await loadOverview(org, slug) : null;

  return (
    <RolePlayPreview
      rolePlay={rolePlay}
      availableUsers={availableUsers}
      assignments={assignmentSummaries}
      overview={overviewData ? <ScenarioOverview data={overviewData} /> : undefined}
    />
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CONVERSATIONS = 50;

type TranscriptTurn = { role?: string; speaker?: string; text?: string };

/** What the overview shows for a published role play or scenario; only data the sessions record. */
async function loadOverview(org: TrainerOrg, slug: string): Promise<ScenarioOverviewData | null> {
  const agent = await db.agent.findFirst({
    where: { slug, orgId: org.id },
    select: { id: true, slug: true, name: true, data: true, persona: { select: { name: true, data: true } } },
  });
  if (!agent) return null;

  const where = { orgId: org.id, agentId: agent.id, deletedAt: null };
  const [totalSessions, sessions] = await Promise.all([
    db.interviewSession.count({ where }),
    db.interviewSession.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: MAX_CONVERSATIONS,
      select: { id: true, createdAt: true, transcript: true, report: true, user: { select: { name: true, email: true } } },
    }),
  ]);

  const roleplay = getStoredRoleplay(agent.data);
  const data = (agent.data ?? {}) as { objective?: unknown };
  const personaData = (agent.persona.data ?? {}) as { avatar?: unknown };
  const aiName = roleplay?.client_name ?? agent.persona.name;

  // Sessions per day for the last seven days, oldest first.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const week = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(today.getTime() - (6 - index) * DAY_MS);
    return { start: day.getTime(), label: day.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }), count: 0 };
  });
  for (const session of sessions) {
    const time = session.createdAt.getTime();
    const day = week.find((bucket) => time >= bucket.start && time < bucket.start + DAY_MS);
    if (day) day.count += 1;
  }

  const conversations = sessions.map((session) => {
    const turns = Array.isArray(session.transcript) ? (session.transcript as TranscriptTurn[]) : [];
    const isLearner = (turn: TranscriptTurn) => turn.role === "user" || turn.speaker === "learner";
    const firstText = (match: (turn: TranscriptTurn) => boolean) =>
      turns.find((turn) => match(turn) && typeof turn.text === "string" && turn.text.trim())?.text?.trim();
    const report = isSessionReport(session.report) ? session.report : null;
    return {
      id: session.id,
      learnerName: session.user.name || session.user.email,
      aiLine: firstText((turn) => !isLearner(turn)),
      learnerLine: firstText(isLearner),
      score: typeof report?.score === "number" ? Math.round(report.score) : undefined,
      createdAt: session.createdAt.toLocaleDateString("en-US", { day: "numeric", month: "short" }),
    };
  });

  return {
    name: agentDisplayName(agent.slug, agent.name),
    personaLabel: roleplay ? "Client persona" : "Trainer persona",
    personaName: aiName,
    personaAvatar: typeof personaData.avatar === "string" && personaData.avatar ? personaData.avatar : undefined,
    scenarioLabel: roleplay ? "Situation" : "Objective",
    scenarioText: roleplay?.situation?.scenario ?? (typeof data.objective === "string" ? data.objective : undefined),
    aiName,
    week: week.map(({ label, count }) => ({ label, count })),
    scores: conversations
      .map((conversation) => conversation.score)
      .filter((score): score is number => typeof score === "number")
      .slice(0, 12)
      .reverse(),
    totalSessions,
    conversations,
  };
}

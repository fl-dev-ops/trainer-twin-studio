import { db } from "@/lib/db";
import { getStoredRoleplay } from "@/lib/roleplay";
import { isSessionReport, type SessionReport } from "@/lib/session-report";
import { agentDisplayName } from "@/lib/specs";

type Turn = { role?: string; speaker?: string; text?: string };

export const isLearnerTurn = (turn: Turn) => turn.role === "user" || turn.speaker === "learner";

export function transcriptTurns(transcript: unknown): Turn[] {
  return Array.isArray(transcript) ? (transcript as Turn[]).filter((turn) => typeof turn?.text === "string" && turn.text.trim()) : [];
}

export function sessionMinutes(start: Date | null, end: Date | null): number | null {
  if (!start || !end) return null;
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / 60_000));
}

export type RoleplaySessionRow = {
  id: string;
  learner: string;
  title: string;
  at: string;
  minutes: number | null;
  score: string | null;
  line?: string;
};

/** Every role-play session in the org, newest first, for the Role play sessions list. */
export async function listRoleplaySessions(orgId: string): Promise<RoleplaySessionRow[]> {
  const sessions = await db.interviewSession.findMany({
    where: { orgId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true, createdAt: true, startedAt: true, endedAt: true, transcript: true, report: true,
      user: { select: { name: true, email: true } },
      agent: { select: { slug: true, name: true, data: true } },
    },
  });
  return sessions
    .filter((session) => getStoredRoleplay(session.agent.data))
    .map((session) => {
      const report = isSessionReport(session.report) ? session.report : null;
      const line = transcriptTurns(session.transcript).find(isLearnerTurn)?.text?.trim();
      return {
        id: session.id,
        learner: session.user.name || session.user.email,
        title: agentDisplayName(session.agent.slug, session.agent.name),
        at: (session.startedAt ?? session.createdAt).toISOString(),
        minutes: sessionMinutes(session.startedAt, session.endedAt),
        score: typeof report?.score === "number" ? (report.score / 10).toFixed(1) : null,
        line,
      };
    });
}

export type RoleplayUserRow = { name: string; email: string; roleplays: number; sessions: number };

/** People practising on the org's role plays: anyone assigned one or with a role-play session. */
export async function listRoleplayUsers(orgId: string): Promise<RoleplayUserRow[]> {
  const [assignments, sessions] = await Promise.all([
    db.rolePlayAssignment.findMany({
      where: { orgId, status: { not: "cancelled" } },
      select: { recipientEmail: true, deploymentId: true, member: { select: { user: { select: { name: true } } } } },
    }),
    db.interviewSession.findMany({
      where: { orgId, deletedAt: null },
      select: { agent: { select: { data: true } }, user: { select: { name: true, email: true } } },
    }),
  ]);

  const people = new Map<string, { name: string; email: string; deployments: Set<string>; sessions: number }>();
  const person = (email: string, name?: string | null) => {
    const key = email.trim().toLowerCase();
    const existing = people.get(key) ?? { name: "", email: email.trim(), deployments: new Set<string>(), sessions: 0 };
    if (!existing.name && name) existing.name = name;
    people.set(key, existing);
    return existing;
  };
  for (const assignment of assignments) {
    person(assignment.recipientEmail, assignment.member?.user.name).deployments.add(assignment.deploymentId);
  }
  for (const session of sessions) {
    if (!getStoredRoleplay(session.agent.data)) continue;
    person(session.user.email, session.user.name).sessions += 1;
  }
  return [...people.values()]
    .map((entry) => ({ name: entry.name || entry.email.split("@")[0], email: entry.email, roleplays: entry.deployments.size, sessions: entry.sessions }))
    .sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
}

export type RoleplaySessionReportData = {
  id: string;
  learner: string;
  title: string;
  agentSlug: string;
  at: string;
  minutes: number | null;
  client: string;
  clientAvatar?: string;
  hasVideo: boolean;
  report: SessionReport | null;
  reportStatus: string | null;
  turns: Array<{ who: "client" | "learner"; text: string }>;
};

export async function readRoleplaySession(orgId: string, id: string): Promise<RoleplaySessionReportData | null> {
  const session = await db.interviewSession.findFirst({
    where: { id, orgId, deletedAt: null },
    select: {
      id: true, createdAt: true, startedAt: true, endedAt: true, transcript: true, report: true, reportStatus: true,
      videoEgressId: true, evidence: true,
      user: { select: { name: true, email: true } },
      agent: { select: { slug: true, name: true, data: true, persona: { select: { name: true, data: true } } } },
    },
  });
  if (!session) return null;
  const roleplay = getStoredRoleplay(session.agent.data);
  if (!roleplay) return null;
  const evidence = (session.evidence ?? {}) as Record<string, unknown>;
  const avatar = (session.agent.persona.data as { avatar?: unknown } | null)?.avatar;
  return {
    id: session.id,
    learner: session.user.name || session.user.email,
    title: agentDisplayName(session.agent.slug, session.agent.name),
    agentSlug: session.agent.slug,
    at: (session.startedAt ?? session.createdAt).toISOString(),
    minutes: sessionMinutes(session.startedAt, session.endedAt),
    client: roleplay.client_name ?? session.agent.persona.name,
    clientAvatar: typeof avatar === "string" && avatar ? avatar : undefined,
    hasVideo: Boolean(session.videoEgressId || evidence.videoS3Key || evidence.videoUrl),
    report: isSessionReport(session.report) ? session.report : null,
    reportStatus: session.reportStatus,
    turns: transcriptTurns(session.transcript).map((turn) => ({ who: isLearnerTurn(turn) ? "learner" : "client", text: turn.text!.trim() })),
  };
}

import { headers } from "next/headers";
import type { ComponentProps } from "react";
import type { SessionView } from "@/components/session-view";
import type { TwinLearnerFlow, LearnerAccess } from "@/components/twin/twin-learner-flow";
import { assignmentMatchesUser } from "@/lib/assignments";
import { signInUrl } from "@/lib/base-domain";
import { db } from "@/lib/db";
import { isStudioRole } from "@/lib/org";
import { agentPhotoUrls } from "@/lib/persona-media";
import { presignedGetUrl } from "@/lib/s3";
import { resolveSessionUser } from "@/lib/session-user";
import { listAgentContextRequired, listAgentContextUploads, listScenarioIntroVideos } from "@/lib/specs";
import { resolveTwinPath, TwinAccessError, twinAccessByCode, twinAssignmentCode } from "@/lib/twin-access";
import { beforeSettings } from "@/lib/context-upload";

/**
 * Learner-portal pages (<org>.<base>/t/<path>, /s/<code>). They run on the org's subdomain, so the org comes from the
 * request host (resolveSessionUser), as it did when these pages rendered on the server.
 */

type SessionViewProps = ComponentProps<typeof SessionView>;

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const dataImage = (logo: string | null) => (/^data:image\/(?:png|jpeg|webp);base64,/.test(logo ?? "") ? logo : null);

/** A twin opened from a learner link: the voice session screen started with that code. Minutes are enforced when the session starts. */
async function twinSessionView(orgId: string, agentId: string, code: string, userName: string): Promise<SessionViewProps> {
  const [agent, organization] = await Promise.all([
    db.agent.findFirstOrThrow({ where: { id: agentId, orgId }, select: { slug: true, name: true, persona: { select: { slug: true } } } }),
    db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true, logo: true } }),
  ]);
  const [introVideos, agentPhotos, agentContextRequired, agentContextUploads] = await Promise.all([
    listScenarioIntroVideos(orgId, [agent.slug]),
    agentPhotoUrls(orgId, [agent.slug]),
    listAgentContextRequired(orgId, [agent.slug]),
    listAgentContextUploads(orgId, [agent.slug]),
  ]);
  return {
    personas: [agent.persona.slug],
    agents: [agent.slug],
    scenarioName: agent.name,
    userName,
    organizationName: organization.name,
    organizationLogo: dataImage(organization.logo),
    agentPersonas: { [agent.slug]: agent.persona.slug },
    agentContextRequired,
    agentContextUploads,
    introVideos,
    agentPhotos,
    autoStart: true,
    contexts: [],
    sessionCode: code,
  };
}

export type SharedSessionView =
  | { kind: "signIn"; url: string }
  | { kind: "twinUnavailable"; message: string; email: string }
  | { kind: "switchAccount"; email: string; returnTo: string }
  | { kind: "invalid" }
  | { kind: "session"; props: SessionViewProps };

/** /s/<code>: a role-play invite, or a twin assignment / share link, for the signed-in learner. */
export async function loadSharedSession(code: string): Promise<SharedSessionView> {
  const host = (await headers()).get("host") ?? "";
  const { org, user } = await resolveSessionUser();
  if (!user) return { kind: "signIn", url: signInUrl(host, `/s/${encodeURIComponent(code)}`) };

  const assignment = org ? await db.rolePlayAssignment.findUnique({
    where: { shareCode: code },
    select: {
      id: true,
      orgId: true,
      status: true,
      expiresAt: true,
      recipientEmail: true,
      member: { select: { userId: true } },
      deployment: {
        select: {
          agent: { select: { slug: true, name: true, persona: { select: { slug: true } } } },
        },
      },
      organization: { select: { name: true, logo: true } },
    },
  }) : null;
  // Not a role-play invite: maybe a twin assignment or a twin share link. Checked here without creating
  // anything; the user's assignment is created when the session starts (POST /api/sessions).
  if (!assignment && org) {
    const twin = await twinAccessByCode({ orgId: org.id, user, code, join: false }).catch((error: unknown) => {
      if (error instanceof TwinAccessError) return error;
      throw error;
    });
    if (twin instanceof TwinAccessError) return { kind: "twinUnavailable", message: twin.message, email: user.email };
    if (twin) return { kind: "session", props: await twinSessionView(org.id, twin.agentId, code, user.name) };
  }
  const spent = assignment
    ? (await db.interviewSession.count({
        where: { assignmentId: assignment.id, status: { in: ["completed", "abandoned"] } },
      })) > 0
    : false;
  const open = assignment && assignment.orgId === org?.id && assignment.status === "pending" && !spent && assignment.expiresAt > new Date();
  if (open && !assignmentMatchesUser(assignment, user)) {
    return { kind: "switchAccount", email: user.email, returnTo: signInUrl(host, `/s/${encodeURIComponent(code)}`) };
  }
  if (!open || !assignment || !org) return { kind: "invalid" };

  const agent = assignment.deployment.agent;
  const [introVideos, agentPhotos, agentContextRequired, agentContextUploads] = await Promise.all([
    listScenarioIntroVideos(org.id, [agent.slug]),
    agentPhotoUrls(org.id, [agent.slug]),
    listAgentContextRequired(org.id, [agent.slug]),
    listAgentContextUploads(org.id, [agent.slug]),
  ]);
  return {
    kind: "session",
    props: {
      personas: [agent.persona.slug],
      agents: [agent.slug],
      scenarioName: agent.name,
      userName: user.name,
      organizationName: assignment.organization.name,
      organizationLogo: dataImage(assignment.organization.logo),
      agentPersonas: { [agent.slug]: agent.persona.slug },
      agentContextRequired,
      agentContextUploads,
      introVideos,
      agentPhotos,
      autoStart: true,
      contexts: [],
      sessionCode: code,
    },
  };
}

export type TwinLinkView = { kind: "notFound" } | { kind: "flow"; props: ComponentProps<typeof TwinLearnerFlow> };

/**
 * A twin's readable link: /t/<username> (the trainer's main twin) or /t/<slug> (a skill twin). What the twin is, the
 * person's access and minutes; studio members (admin, team) get a preview that uses no minutes.
 */
export async function loadTwinLink(slug: string): Promise<TwinLinkView> {
  const { org, user } = await resolveSessionUser();

  const twin = org ? await resolveTwinPath(org.id, org.slug, slug) : null;
  if (!org || !twin) return { kind: "notFound" };

  const agent = await db.agent.findUniqueOrThrow({
    where: { id: twin.agentId },
    select: {
      slug: true,
      name: true,
      data: true,
      persona: { select: { name: true, data: true, avatar: { select: { s3ImageKey: true } } } },
    },
  });

  // Signed in: their access to this twin (minutes left), or why they can't talk to it. Studio members (admin, team)
  // get a preview: the learner page as learners see it, calls started like Try as learner (no minutes, not counted).
  let access: LearnerAccess = null;
  const membership = user ? await db.member.findFirst({ where: { organizationId: org.id, userId: user.id }, select: { role: true } }) : null;
  if (user && isStudioRole(membership?.role)) {
    access = { ok: true, preview: true, name: user.name || user.email, email: user.email };
  } else if (user) {
    try {
      const found = await twinAssignmentCode({ orgId: org.id, user, agentId: twin.agentId });
      access = { ok: true, preview: false, name: user.name || user.email, email: user.email, code: found.code, minutesLeft: Math.floor(found.secondsLeft / 60), minutesTotal: found.minutesLimit };
    } catch (error) {
      if (!(error instanceof TwinAccessError)) throw error;
      // In the learner's words: why they can't talk (messages from usable() in lib/twin-access.ts).
      const reason = /minutes/.test(error.message) ? "used" : /removed/.test(error.message) ? "ended" : "unassigned";
      access = { ok: false, name: user.name || user.email, email: user.email, reason };
    }
  }

  // Presigned here: the avatar route is for org members, and visitors on this page may not be signed in yet.
  const photoKey = agent.persona.avatar?.s3ImageKey;
  const photoUrl = photoKey ? await presignedGetUrl(photoKey, 3600).catch(() => null) : null;
  const persona = agent.persona.data && typeof agent.persona.data === "object" ? (agent.persona.data as Record<string, unknown>) : {};
  const data = agent.data && typeof agent.data === "object" ? (agent.data as Record<string, unknown>) : {};
  return {
    kind: "flow",
    props: {
      path: `/t/${encodeURIComponent(slug)}`,
      trainer: {
        name: text(persona.name) ?? agent.persona.name,
        title: [text(persona.role), text(persona.based_in)].filter(Boolean).join(" · ") || null,
        bio: text(persona.background),
        photoUrl,
      },
      // attach: the twin's "Enable upload" during the call (images only, up to 10 MB; enforced by the attach route).
      twin: { slug: agent.slug, name: agent.name, description: text(data.objective), attach: beforeSettings(agent.data).duringUpload },
      access,
    },
  };
}

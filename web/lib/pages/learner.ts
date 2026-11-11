import { headers } from "next/headers";
import type { ComponentProps } from "react";
import type { SessionView } from "@/components/session-view";
import type { TwinLearnerFlow, LearnerAccess } from "@/components/twin/twin-learner-flow";
import { signInUrl } from "@/lib/base-domain";
import { db } from "@/lib/db";
import { isStudioRole } from "@/lib/org";
import { orgPerson } from "@/lib/org-people";
import { agentPhotoUrls } from "@/lib/persona-media";
import { presignedGetUrl } from "@/lib/s3";
import { resolveSessionUser } from "@/lib/session-user";
import { listAgentContextRequired, listAgentContextUploads, listScenarioIntroVideos } from "@/lib/specs";
import { learnerBalance } from "@/lib/minutes";
import { AppError } from "@/lib/errors";
import { practicePerson, startAllowance } from "@/lib/practice";
import { roleplayAccessByCode } from "@/lib/roleplay-access";
import { assertLiveTwin, resolveTwinPath, twinAccessByCode, twinAssignmentCode } from "@/lib/twin-access";
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
  | { kind: "outOfMinutes"; email: string; minutesLeft: number }
  | { kind: "invalid" }
  | { kind: "session"; props: SessionViewProps };

/** /s/<code>: a role-play invite, or a twin assignment / share link, for the signed-in learner. */
export async function loadSharedSession(code: string): Promise<SharedSessionView> {
  const host = (await headers()).get("host") ?? "";
  const { org, user } = await resolveSessionUser();
  if (!user) return { kind: "signIn", url: signInUrl(host, `/s/${encodeURIComponent(code)}`) };
  // A learner's minutes left in this org (null for admin and team, who practise without using minutes).
  const minutesLeft = async (): Promise<number | null> => {
    if (!org) return null;
    const member = await orgPerson(org.id, { userId: user.id });
    if (isStudioRole(member?.role)) return null;
    return Math.floor(Math.max(0, (await learnerBalance(org.id, user.email)).balanceSeconds) / 60);
  };

  if (!org) return { kind: "invalid" };
  const refusal = (error: unknown) => {
    if (error instanceof AppError) return error;
    throw error;
  };
  // A role-play link: the check Start runs, in its order (specs/practice.md rule 17).
  // The page always starts a voice call: a role play that can't be one is refused here too.
  const roleplay = await roleplayAccessByCode({ orgId: org.id, userId: user.id, code, mode: "voice" }).catch(refusal);
  if (roleplay instanceof AppError) {
    if (roleplay.code === "roleplay_not_assigned") return { kind: "switchAccount", email: user.email, returnTo: signInUrl(host, `/s/${encodeURIComponent(code)}`) };
    if (roleplay.code === "not_found") return { kind: "invalid" };
    return { kind: "twinUnavailable", message: roleplay.message, email: user.email };
  }
  if (!roleplay) {
    // Not a role-play link: maybe a twin assignment or a twin share link (opening a share link adds an existing
    // account to the org with the twin: specs/people.md rule 6; starting the call only uses that membership).
    const twin = await twinAccessByCode({ orgId: org.id, user, code, join: true }).catch(refusal);
    if (twin instanceof AppError) return { kind: "twinUnavailable", message: twin.message, email: user.email };
    if (!twin) return { kind: "invalid" };
    // The practice check Start uses (specs/practice.md rule 1): the page shows its refusal instead of a Start.
    const refused = await practicePerson(org.id, user.id).then((person) => startAllowance(org.id, person)).then(() => null, refusal);
    // Someone who just joined through a common link got their starting credits on the way in.
    const left = twin.assignmentId ? await minutesLeft() : null;
    if (refused?.code === "credits_out" || refused?.code === "credits_short") return { kind: "outOfMinutes", email: user.email, minutesLeft: Math.max(0, left ?? 0) };
    if (refused) return { kind: "twinUnavailable", message: refused.message, email: user.email };
    return { kind: "session", props: { ...(await twinSessionView(org.id, twin.agentId, code, user.name)), minutesLeft: left } };
  }
  const refused = await startAllowance(org.id, roleplay.person).then(() => null, refusal);
  const left = await minutesLeft();
  if (refused?.code === "credits_out" || refused?.code === "credits_short") return { kind: "outOfMinutes", email: user.email, minutesLeft: Math.max(0, left ?? 0) };
  if (refused) return { kind: "twinUnavailable", message: refused.message, email: user.email };

  const assignment = await db.rolePlayAssignment.findUniqueOrThrow({
    where: { id: roleplay.assignmentId },
    select: {
      deployment: { select: { agent: { select: { slug: true, name: true, persona: { select: { slug: true } } } } } },
      organization: { select: { name: true, logo: true } },
    },
  });
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
      minutesLeft: left,
    },
  };
}

export type TwinLinkView = { kind: "notFound" } | { kind: "flow"; props: ComponentProps<typeof TwinLearnerFlow> };
type FlowProps = ComponentProps<typeof TwinLearnerFlow>;

/** A trainer as their twin pages show them: photo, full name, role · place, and about. Public (no sign-in needed). */
export async function trainerProfile(personaId: string): Promise<FlowProps["trainer"]> {
  const found = await db.persona.findUniqueOrThrow({
    where: { id: personaId },
    select: { name: true, data: true, avatar: { select: { s3ImageKey: true } } },
  });
  // Presigned here: the avatar route is for org members, and visitors on this page may not be signed in yet.
  const photoKey = found.avatar?.s3ImageKey;
  const photoUrl = photoKey ? await presignedGetUrl(photoKey, 3600).catch(() => null) : null;
  const persona = found.data && typeof found.data === "object" ? (found.data as Record<string, unknown>) : {};
  return {
    name: text(persona.name) ?? found.name,
    title: [text(persona.role), text(persona.based_in)].filter(Boolean).join(" · ") || null,
    bio: text(persona.background),
    photoUrl,
  };
}

/** What a twin's page shows about it: the trainer whose twin it is, and the twin. Public (no sign-in needed). */
export async function twinProfile(agentId: string): Promise<Pick<FlowProps, "trainer" | "twin">> {
  const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId }, select: { slug: true, name: true, data: true, personaId: true } });
  const data = agent.data && typeof agent.data === "object" ? (agent.data as Record<string, unknown>) : {};
  return {
    trainer: await trainerProfile(agent.personaId),
    // attach: the twin's "Enable upload" during the call (an image up to 5 MB or a PDF up to 10 MB; enforced by the attach route).
    twin: { slug: agent.slug, name: agent.name, description: text(data.objective), attach: beforeSettings(agent.data).duringUpload },
  };
}

/** The page's word for a refusal it has its own copy for; any other refusal shows its message (`blocked`). */
const ACCESS_REASONS: Record<string, "notMember" | "unassigned" | "ended" | "used"> = {
  no_org: "notMember",
  twin_not_assigned: "unassigned",
  twin_access_revoked: "ended",
  twin_access_ended: "ended",
  credits_out: "used",
};

/**
 * The signed-in person's access to a twin (null: signed out), from the practice check that Start uses
 * (specs/practice.md rule 1): their minutes left, or why they can't talk to it. Studio members (admin, team) get a
 * preview, refused too when Start would refuse it (org paused, org credits short).
 */
export async function twinAccessFor(org: { id: string }, user: { id: string; name: string; email: string } | null, agentId: string): Promise<LearnerAccess> {
  if (!user) return null;
  const name = user.name || user.email;
  try {
    const person = await practicePerson(org.id, user.id);
    await assertLiveTwin(org.id, agentId);
    const code = isStudioRole(person.role) ? null : (await twinAssignmentCode({ orgId: org.id, user, agentId })).code;
    await startAllowance(org.id, person);
    if (!code) return { ok: true, preview: true, name, email: user.email };
    // The learner's own minutes in this org, shared by every twin and role play they have.
    const minutes = await learnerBalance(org.id, user.email);
    return { ok: true, preview: false, name, email: user.email, code, minutesLeft: Math.floor(minutes.balanceSeconds / 60), minutesTotal: Math.floor(minutes.grantedSeconds / 60) };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { ok: false, name, email: user.email, reason: ACCESS_REASONS[error.code] ?? "blocked", message: error.message };
  }
}

/** Whether this user is on the org's studio team (admin, team). */
export async function isStudioMember(orgId: string, userId: string) {
  const membership = await orgPerson(orgId, { userId });
  return isStudioRole(membership?.role) && !membership?.disabled;
}

/**
 * A twin's readable link: /t/<username> (the trainer's main twin) or /t/<slug> (a skill twin). What the twin is, the
 * person's access and minutes; studio members (admin, team) get a preview that uses no minutes.
 */
export async function loadTwinLink(slug: string): Promise<TwinLinkView> {
  const { org, user } = await resolveSessionUser();
  const twin = org ? await resolveTwinPath(org.id, org.slug, slug) : null;
  if (!org || !twin) return { kind: "notFound" };
  const [profile, access] = await Promise.all([
    twinProfile(twin.agentId),
    twinAccessFor(org, user, twin.agentId),
  ]);
  return { kind: "flow", props: { path: `/t/${encodeURIComponent(slug)}`, ...profile, access } };
}

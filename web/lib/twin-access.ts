import { z } from "zod";
import { randomBytes } from "node:crypto";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { db, isUniqueViolation } from "@/lib/db";
import { refusals } from "@/lib/errors";
import { DEFAULT_LEARNER_MINUTES, learnerMinutes } from "@/lib/minutes";
import { addPeopleToOrg, LEARNER, orgPeople, orgPerson } from "@/lib/org-people";
import { TWIN_SOURCE } from "@/lib/twins";

/**
 * Twin access. A learner uses a twin through a TwinAssignment: one per member per twin (specs/people.md: always a
 * member of the org, never an email alone). A TwinShareLink adds each signed-in person who opens it to the org as a
 * learner with their own assignment. Admin and team (studio roles) use twins without an assignment. Credits are the
 * learner's own (lib/minutes.ts).
 */

export class TwinAccessError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "TwinAccessError";
  }
}

export const newTwinShareCode = () => randomBytes(18).toString("base64url");

/** The learner-facing link for a twin assignment or share link code. */
export const twinUrl = (orgSlug: string, code: string) => `https://${orgSlug}.${BASE_DOMAIN}/s/${code}`;

/** The readable shared link: /t/<username> for the main twin, /t/<short slug> for a skill twin. */
export const twinShareUrl = (orgSlug: string, path: string) => `https://${orgSlug}.${BASE_DOMAIN}/t/${path}`;

/** A skill twin's slug without the org prefix ("acme-off-plan" in org "acme" \u2192 "off-plan"). */
export const shortTwinSlug = (orgSlug: string, slug: string) =>
  slug.startsWith(`${orgSlug}-`) && slug.length > orgSlug.length + 1 ? slug.slice(orgSlug.length + 1) : slug;

export const isAllSkillsTwin = (data: unknown) => (data as Record<string, unknown> | null)?.source === TWIN_SOURCE;

/**
 * The /t/<path> of a twin. Main twin (all skills): its trainer's own persona slug (the username). Skill twin: the
 * short slug, or the full slug when the short one is someone's username (usernames win when resolving).
 */
export async function twinSharePath(orgId: string, orgSlug: string, agentId: string) {
  const agent = await db.agent.findFirst({
    where: { id: agentId, orgId, kind: "TWIN" },
    select: { slug: true, data: true, persona: { select: { slug: true, isOwn: true } } },
  });
  if (!agent) throw new TwinAccessError("Twin not found", 404);
  if (isAllSkillsTwin(agent.data) && agent.persona.isOwn) return agent.persona.slug;
  const short = shortTwinSlug(orgSlug, agent.slug);
  if (short === agent.slug) return agent.slug;
  const username = await db.persona.findFirst({ where: { orgId, isOwn: true, slug: { equals: short, mode: "insensitive" } }, select: { id: true } });
  return username ? agent.slug : short;
}

/**
 * Which twin a /t/<path> opens in this org: a username (own persona slug) opens that trainer's main twin; otherwise
 * a skill twin by short slug, then by full slug. Null: nothing here.
 */
export async function resolveTwinPath(orgId: string, orgSlug: string, path: string): Promise<{ agentId: string } | null> {
  const value = path.trim().toLowerCase();
  if (!value || value.length > 200) return null;
  const persona = await db.persona.findFirst({ where: { orgId, isOwn: true, slug: { equals: value, mode: "insensitive" } }, select: { id: true } });
  if (persona) {
    const twins = await db.agent.findMany({ where: { orgId, kind: "TWIN", personaId: persona.id, archivedAt: null }, select: { id: true, data: true } });
    const main = twins.find((twin) => isAllSkillsTwin(twin.data));
    if (main) return { agentId: main.id };
  }
  for (const slug of [`${orgSlug}-${value}`, value]) {
    const agent = await db.agent.findFirst({ where: { orgId, kind: "TWIN", slug, archivedAt: null }, select: { id: true } });
    if (agent) return { agentId: agent.id };
  }
  return null;
}

/**
 * Legacy: TwinAssignment.minutesLimit and TwinShareLink.minutesPerUser are still required columns, but minutes are
 * per learner now (lib/minutes.ts); new rows get this value and nothing reads it. shortcut: drop both columns once the
 * minutes ledger has run a release.
 */
export const DEFAULT_TWIN_MINUTES = DEFAULT_LEARNER_MINUTES;

type Person = { id: string; email: string };
type AssignmentRow = {
  id: string;
  agentId: string;
  status: string;
  userId: string;
  accessUntil: Date | null;
};

const assignmentSelect = { id: true, agentId: true, status: true, userId: true, accessUntil: true } as const;

/** An assignment's end date (set when assigning): optional, and only a future date makes sense. */
export const accessUntilSchema = z.coerce
  .date()
  .refine((date) => date.getTime() > Date.now(), "Pick an end date in the future")
  .nullable()
  .optional();

/** Still within the end date (no end date: always). */
export const withinAccess = (accessUntil: Date | null, now = new Date()) => !accessUntil || accessUntil.getTime() > now.getTime();

/**
 * Active, the user's own (by account, never by email), within its end date. Throws TwinAccessError otherwise.
 * Access only: how long a call may run comes from the learner's minutes (lib/minutes.ts), checked when it starts.
 */
function usable(assignment: AssignmentRow | null, user: Person) {
  if (!assignment || assignment.userId !== user.id) throw new TwinAccessError("This twin is not assigned to your account", 403);
  if (assignment.status !== "active") throw new TwinAccessError("Your access to this twin was removed", 403);
  // Checked when a call starts; a call already running finishes.
  if (!withinAccess(assignment.accessUntil)) throw new TwinAccessError("Your access to this twin has ended", 403);
  return { assignmentId: assignment.id, agentId: assignment.agentId };
}

/** What a /s/<code> code is for twins: a personal assignment or a common share link (null: not a twin code). */
export async function findTwinCode(code: string) {
  const assignment = await db.twinAssignment.findUnique({ where: { shareCode: code }, select: { ...assignmentSelect, orgId: true } });
  if (assignment) return { type: "assignment" as const, orgId: assignment.orgId, agentId: assignment.agentId, assignment };
  const link = await db.twinShareLink.findUnique({
    where: { code },
    select: { id: true, orgId: true, agentId: true, minutesPerUser: true, status: true, createdByUserId: true },
  });
  return link ? { type: "link" as const, orgId: link.orgId, agentId: link.agentId, link } : null;
}

/**
 * Twin access through a code (personal assignment or common link). A link reuses the user's assignment on that twin;
 * with `join` set (only when the link page opens: lib/pages/learner.ts), an existing account not yet in the org is
 * added as a learner (with starting credits) and given the twin. A call start passes join=false and never adds anyone.
 * Admin and team need no assignment. Returns null when the code is not a twin code.
 */
export async function twinAccessByCode(input: { orgId: string; user: Person; code: string; join: boolean }) {
  const found = await findTwinCode(input.code);
  if (!found) return null;
  if (found.orgId !== input.orgId) throw new TwinAccessError("This twin link belongs to another organization", 403);
  if (found.type === "assignment") return usable(found.assignment, input.user);

  if (found.link.status !== "active") throw new TwinAccessError("This twin link is no longer active", 403);
  // A disabled member gets nothing through a link, even with an assignment left over (specs/people.md rule 8).
  const member = await orgPerson(input.orgId, { userId: input.user.id });
  if (member?.disabled) throw refusals.memberDisabled();
  const existing = await db.twinAssignment.findUnique({
    where: { agentId_userId: { agentId: found.agentId, userId: input.user.id } },
    select: assignmentSelect,
  });
  if (existing) return usable(existing, input.user);
  if (member && member.role !== LEARNER) return { assignmentId: null, agentId: found.agentId };
  if (!input.join) return { assignmentId: null, agentId: found.agentId };
  // Refused (credits short, org paused…) with its own code and status; nothing is written then.
  await addPeopleToOrg({ orgId: input.orgId, emails: [input.user.email], role: LEARNER, byUserId: found.link.createdByUserId });
  const created = await db.twinAssignment.create({
    data: {
      orgId: input.orgId,
      agentId: found.agentId,
      userId: input.user.id,
      minutesLimit: DEFAULT_TWIN_MINUTES,
      shareCode: newTwinShareCode(),
      shareLinkId: found.link.id,
    },
    select: assignmentSelect,
  }).catch(async (error: unknown) => {
    // Two tabs joining at once: the unique (agentId, userId) keeps one; use it.
    if (isUniqueViolation(error)) {
      return db.twinAssignment.findUniqueOrThrow({
        where: { agentId_userId: { agentId: found.agentId, userId: input.user.id } },
        select: assignmentSelect,
      });
    }
    throw error;
  });
  return usable(created, input.user);
}

/**
 * /t/<path> access: the user's own active assignment on that twin (bound on first use). Returns its personal code,
 * which the call starts with; throws TwinAccessError when not assigned / revoked / past its end date.
 */
export async function twinAssignmentCode(input: { orgId: string; user: Person; agentId: string }) {
  const access = await twinAccessByAgent(input);
  const assignment = await db.twinAssignment.findUniqueOrThrow({ where: { id: access.assignmentId }, select: { shareCode: true } });
  return { code: assignment.shareCode };
}

/** Twin access for a direct start (portal / talk page): the user's own assignment on that twin. */
export async function twinAccessByAgent(input: { orgId: string; user: Person; agentId: string }) {
  const assignment = await db.twinAssignment.findFirst({
    where: { orgId: input.orgId, agentId: input.agentId, userId: input.user.id },
    select: assignmentSelect,
  });
  return usable(assignment, input.user);
}

// ---- Studio management (admin / team) ----

/** The org's twin agent by slug; role plays, other orgs' agents and archived twins are not found here. */
export async function findTwinAgent(orgId: string, slug: string) {
  const agent = await db.agent.findFirst({ where: { orgId, slug, kind: "TWIN", archivedAt: null }, select: { id: true, slug: true, name: true } });
  if (!agent) throw new TwinAccessError(`Twin "${slug}" was not found`, 404);
  return agent;
}

/**
 * Every learner assigned to a twin (link joiners included), with their minutes: given and used across every twin and
 * role play of the org (minutes are per learner, not per twin). `email` is the member's account email.
 */
export async function listTwinAssignments(orgId: string, agentId: string) {
  // The org's learners only (specs/people.md rule 7: admin and team hold no learner assignments).
  const learners = await orgPeople(orgId, { roles: [LEARNER], includeDisabled: true });
  const rows = await db.twinAssignment.findMany({
    where: { orgId, agentId, userId: { in: learners.map((person) => person.userId) } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, status: true, accessUntil: true, shareCode: true, shareLinkId: true, createdAt: true,
      user: { select: { id: true, name: true, email: true, image: true } },
    },
  });
  const minutes = await learnerMinutes(orgId, rows.map((row) => row.user.email));
  return rows.map(({ user, ...row }) => {
    const email = user.email.toLowerCase();
    const own = minutes.get(email);
    return {
      ...row,
      email,
      user: { id: user.id, name: user.name, image: user.image },
      minutesGiven: Math.floor((own?.grantedSeconds ?? 0) / 60),
      minutesUsed: Math.round((own?.usedSeconds ?? 0) / 6) / 10,
    };
  });
}

/**
 * Assigns a twin to the org's learners (already members: lib/org-people.ts addPeopleToOrg) with an optional end date.
 * A revoked assignment is reactivated with the new date; an active one is left alone. Returns who should be emailed.
 */
export async function assignTwin(input: {
  orgId: string;
  agentId: string;
  people: { userId: string; email: string }[];
  accessUntil?: Date | null;
  assignedByUserId: string;
}) {
  const accessUntil = input.accessUntil ?? null;
  const existing = await db.twinAssignment.findMany({
    where: { agentId: input.agentId, userId: { in: input.people.map((person) => person.userId) } },
    select: { id: true, userId: true, status: true },
  });
  const byUser = new Map(existing.map((row) => [row.userId, row]));
  const stats = { added: 0, reactivated: 0, skipped: 0 };
  const invites: { to: string; shareCode: string }[] = [];
  for (const { userId, email } of input.people) {
    const current = byUser.get(userId);
    if (current?.status === "active") {
      stats.skipped++;
      continue;
    }
    const shareCode = newTwinShareCode();
    if (current) {
      await db.twinAssignment.update({ where: { id: current.id }, data: { status: "active", accessUntil, shareCode } });
      stats.reactivated++;
    } else {
      await db.twinAssignment.create({
        data: { orgId: input.orgId, agentId: input.agentId, userId, minutesLimit: DEFAULT_TWIN_MINUTES, accessUntil, shareCode, assignedByUserId: input.assignedByUserId },
      });
      stats.added++;
    }
    invites.push({ to: email, shareCode });
  }
  return { stats, invites };
}

/** Revokes or restores one assignment. */
export async function updateTwinAssignment(input: { orgId: string; agentId: string; assignmentId: string; status: "active" | "revoked" }) {
  const found = await db.twinAssignment.findFirst({ where: { id: input.assignmentId, orgId: input.orgId, agentId: input.agentId }, select: { id: true } });
  if (!found) throw new TwinAccessError("Twin assignment not found", 404);
  return db.twinAssignment.update({
    where: { id: found.id },
    data: { status: input.status },
    select: { id: true, status: true },
  });
}

export async function listTwinShareLinks(orgId: string, agentId: string) {
  return db.twinShareLink.findMany({
    where: { orgId, agentId },
    orderBy: { createdAt: "asc" },
    select: { id: true, code: true, minutesPerUser: true, status: true, createdAt: true, _count: { select: { assignments: true } } },
  });
}

export async function createTwinShareLink(input: { orgId: string; agentId: string; minutesPerUser: number; createdByUserId: string }) {
  return db.twinShareLink.create({
    data: { orgId: input.orgId, agentId: input.agentId, code: newTwinShareCode(), minutesPerUser: input.minutesPerUser, createdByUserId: input.createdByUserId },
    select: { id: true, code: true, minutesPerUser: true, status: true },
  });
}

/** Disabling a link stops new joins; people who already joined keep their own assignment. */
export async function setTwinShareLinkStatus(input: { orgId: string; agentId: string; linkId: string; status: "active" | "disabled" }) {
  const found = await db.twinShareLink.findFirst({ where: { id: input.linkId, orgId: input.orgId, agentId: input.agentId }, select: { id: true } });
  if (!found) throw new TwinAccessError("Share link not found", 404);
  return db.twinShareLink.update({ where: { id: found.id }, data: { status: input.status }, select: { id: true, status: true } });
}

/**
 * Of these runnable agent slugs, the ones this person may start: admin and team see everything; anyone else
 * sees every role play but only the twins they hold an active assignment for.
 */
export async function startableAgentSlugs(orgId: string, user: Person | null, slugs: string[], studio: boolean) {
  if (studio || !slugs.length) return slugs;
  const twins = await db.agent.findMany({ where: { orgId, slug: { in: slugs }, kind: "TWIN" }, select: { id: true, slug: true } });
  if (!twins.length) return slugs;
  const assigned = user
    ? await db.twinAssignment.findMany({
        where: {
          orgId,
          status: "active",
          agentId: { in: twins.map((twin) => twin.id) },
          userId: user.id,
          OR: [{ accessUntil: null }, { accessUntil: { gt: new Date() } }],
        },
        select: { agentId: true },
      })
    : [];
  const allowed = new Set(assigned.map((row) => row.agentId));
  const hidden = new Set(twins.filter((twin) => !allowed.has(twin.id)).map((twin) => twin.slug));
  return slugs.filter((slug) => !hidden.has(slug));
}

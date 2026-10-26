import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";

/**
 * Twin access (migration twin_access). A twin is used through a TwinAssignment: one per user per twin
 * agent, with its own minutes budget. A TwinShareLink gives each signed-in user who opens it their own
 * assignment. Admin and team (studio roles) use twins without an assignment or limit.
 * Minutes used are derived from the assignment's sessions (startedAt..endedAt), never stored.
 */

export class TwinAccessError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "TwinAccessError";
  }
}

export const newTwinShareCode = () => randomBytes(18).toString("base64url");

/**
 * Seconds already used on an assignment. A session still running counts up to now; one that ended
 * without endedAt (crashed, failed) counts as 0. Timestamps are naive UTC, so "now" is taken in UTC:
 * the database session time zone may be anything.
 */
export async function twinSecondsUsed(assignmentId: string): Promise<number> {
  const [row] = await db.$queryRaw<{ seconds: number }[]>`
    SELECT coalesce(sum(extract(epoch FROM (
      coalesce("endedAt", CASE WHEN status IN ('activating', 'active') THEN now() AT TIME ZONE 'UTC' ELSE "startedAt" END)
      - "startedAt"))), 0)::float8 AS seconds
    FROM "InterviewSession"
    WHERE "twinAssignmentId" = ${assignmentId} AND "startedAt" IS NOT NULL`;
  return Math.max(0, row?.seconds ?? 0);
}

type Person = { id: string; email: string };
type AssignmentRow = { id: string; agentId: string; minutesLimit: number; status: string; userId: string | null; recipientEmail: string };

const assignmentSelect = { id: true, agentId: true, minutesLimit: true, status: true, userId: true, recipientEmail: true } as const;
const belongsTo = (assignment: AssignmentRow, user: Person) =>
  assignment.userId ? assignment.userId === user.id : assignment.recipientEmail === user.email.trim().toLowerCase();

/** Active, owned by the user, minutes left; binds the user on first use. Throws TwinAccessError otherwise. */
async function usable(assignment: AssignmentRow | null, user: Person) {
  if (!assignment || !belongsTo(assignment, user)) throw new TwinAccessError("This twin is not assigned to your account", 403);
  if (assignment.status !== "active") throw new TwinAccessError("Your access to this twin was removed", 403);
  const secondsLeft = assignment.minutesLimit * 60 - (await twinSecondsUsed(assignment.id));
  if (secondsLeft <= 0) throw new TwinAccessError("You have used all your minutes with this twin", 403);
  if (!assignment.userId) await db.twinAssignment.update({ where: { id: assignment.id }, data: { userId: user.id } });
  return { assignmentId: assignment.id, agentId: assignment.agentId, secondsLeft: Math.floor(secondsLeft) };
}

/** What a /s/<code> code is for twins: a personal assignment or a common share link (null: not a twin code). */
export async function findTwinCode(code: string) {
  const assignment = await db.twinAssignment.findUnique({ where: { shareCode: code }, select: { ...assignmentSelect, orgId: true } });
  if (assignment) return { type: "assignment" as const, orgId: assignment.orgId, agentId: assignment.agentId, assignment };
  const link = await db.twinShareLink.findUnique({
    where: { code },
    select: { id: true, orgId: true, agentId: true, minutesPerUser: true, status: true },
  });
  return link ? { type: "link" as const, orgId: link.orgId, agentId: link.agentId, link } : null;
}

/**
 * Twin access for a session start through a code (personal assignment or common link). Opening a link
 * reuses the user's assignment on that twin, or creates one with the link's minutes when `join` is set;
 * opening it again never adds minutes. Returns null when the code is not a twin code.
 */
export async function twinAccessByCode(input: { orgId: string; user: Person; code: string; join: boolean }) {
  const found = await findTwinCode(input.code);
  if (!found) return null;
  if (found.orgId !== input.orgId) throw new TwinAccessError("This twin link belongs to another organization", 403);
  if (found.type === "assignment") return usable(found.assignment, input.user);

  if (found.link.status !== "active") throw new TwinAccessError("This twin link is no longer active", 403);
  const email = input.user.email.trim().toLowerCase();
  const existing = await db.twinAssignment.findUnique({
    where: { agentId_recipientEmail: { agentId: found.agentId, recipientEmail: email } },
    select: assignmentSelect,
  });
  if (existing) return usable(existing, input.user);
  if (!input.join) return { assignmentId: null, agentId: found.agentId, secondsLeft: found.link.minutesPerUser * 60 };
  const created = await db.twinAssignment.create({
    data: {
      orgId: input.orgId,
      agentId: found.agentId,
      recipientEmail: email,
      userId: input.user.id,
      minutesLimit: found.link.minutesPerUser,
      shareCode: newTwinShareCode(),
      shareLinkId: found.link.id,
    },
    select: assignmentSelect,
  }).catch(async (error: unknown) => {
    // Two tabs joining at once: the unique (agentId, recipientEmail) keeps one; use it.
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") {
      return db.twinAssignment.findUniqueOrThrow({
        where: { agentId_recipientEmail: { agentId: found.agentId, recipientEmail: email } },
        select: assignmentSelect,
      });
    }
    throw error;
  });
  return usable(created, input.user);
}

/** Twin access for a direct start (portal / talk page): the user's own assignment on that twin. */
export async function twinAccessByAgent(input: { orgId: string; user: Person; agentId: string }) {
  const assignment = await db.twinAssignment.findFirst({
    where: {
      orgId: input.orgId,
      agentId: input.agentId,
      OR: [{ userId: input.user.id }, { userId: null, recipientEmail: input.user.email.trim().toLowerCase() }],
    },
    select: assignmentSelect,
  });
  return usable(assignment, input.user);
}

// ---- Studio management (admin / team) ----

/** The org's twin agent by slug; role plays and other orgs' agents are not twins here. */
export async function findTwinAgent(orgId: string, slug: string) {
  const agent = await db.agent.findFirst({ where: { orgId, slug, kind: "TWIN" }, select: { id: true, slug: true, name: true } });
  if (!agent) throw new TwinAccessError(`Twin "${slug}" was not found`, 404);
  return agent;
}

/** Every user assigned to a twin, with minutes used (link joiners included). */
export async function listTwinAssignments(orgId: string, agentId: string) {
  const rows = await db.twinAssignment.findMany({
    where: { orgId, agentId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, recipientEmail: true, minutesLimit: true, status: true, shareCode: true, shareLinkId: true, createdAt: true,
      user: { select: { id: true, name: true, image: true } },
    },
  });
  return Promise.all(rows.map(async (row) => ({ ...row, minutesUsed: Math.round((await twinSecondsUsed(row.id)) / 6) / 10 })));
}

/**
 * Assigns a twin to people by email with a minutes budget each. A revoked assignment is reactivated with the
 * new minutes; an active one is left alone (change minutes with updateTwinAssignment). People bound to another
 * org are blocked (single-org lock). Returns who needs an invite email.
 */
export async function assignTwin(input: {
  orgId: string;
  agentId: string;
  emails: string[];
  minutes: number;
  assignedByUserId: string;
  homeOrgs: Map<string, string>;
}) {
  const emails = [...new Set(input.emails.map((email) => email.trim().toLowerCase()))];
  const existing = await db.twinAssignment.findMany({
    where: { agentId: input.agentId, recipientEmail: { in: emails } },
    select: { id: true, recipientEmail: true, status: true },
  });
  const byEmail = new Map(existing.map((row) => [row.recipientEmail, row]));
  const stats = { added: 0, reactivated: 0, skipped: 0, blocked: 0 };
  const invites: { to: string; shareCode: string }[] = [];
  for (const email of emails) {
    const home = input.homeOrgs.get(email);
    if (home && home !== input.orgId) {
      stats.blocked++;
      continue;
    }
    const current = byEmail.get(email);
    if (current?.status === "active") {
      stats.skipped++;
      continue;
    }
    const shareCode = newTwinShareCode();
    if (current) {
      await db.twinAssignment.update({ where: { id: current.id }, data: { status: "active", minutesLimit: input.minutes, shareCode } });
      stats.reactivated++;
    } else {
      await db.twinAssignment.create({
        data: { orgId: input.orgId, agentId: input.agentId, recipientEmail: email, minutesLimit: input.minutes, shareCode, assignedByUserId: input.assignedByUserId },
      });
      stats.added++;
    }
    invites.push({ to: email, shareCode });
  }
  return { stats, invites };
}

/** Changes one assignment's minutes or revokes / restores it. */
export async function updateTwinAssignment(input: { orgId: string; agentId: string; assignmentId: string; minutesLimit?: number; status?: "active" | "revoked" }) {
  const found = await db.twinAssignment.findFirst({ where: { id: input.assignmentId, orgId: input.orgId, agentId: input.agentId }, select: { id: true } });
  if (!found) throw new TwinAccessError("Twin assignment not found", 404);
  return db.twinAssignment.update({
    where: { id: found.id },
    data: { ...(input.minutesLimit !== undefined ? { minutesLimit: input.minutesLimit } : {}), ...(input.status ? { status: input.status } : {}) },
    select: { id: true, minutesLimit: true, status: true },
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
          OR: [{ userId: user.id }, { userId: null, recipientEmail: user.email.trim().toLowerCase() }],
        },
        select: { agentId: true },
      })
    : [];
  const allowed = new Set(assigned.map((row) => row.agentId));
  const hidden = new Set(twins.filter((twin) => !allowed.has(twin.id)).map((twin) => twin.slug));
  return slugs.filter((slug) => !hidden.has(slug));
}

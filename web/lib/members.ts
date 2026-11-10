import { orgPeople, orgPerson } from "@/lib/org-people";
import { APIError } from "better-auth/api";
import { db } from "@/lib/db";
import { closeInterviewSession } from "@/lib/session-lifecycle";

/** Org membership rules: one admin per org (fixed for now), and members are disabled, never deleted. */
export const ADMIN_ROLE = "admin";
export const ONE_ADMIN_MESSAGE = "An organization has exactly one admin. Invite or set people as team or user.";
export const NO_REMOVAL_MESSAGE = "Members are not removed. Disable them instead.";
export const DISABLED_MESSAGE = "Your access has been disabled. Contact your trainer.";

export class MemberError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** One admin per org: nobody is invited, added or promoted as a second admin (the admin keeps the role). */
export async function assertNoSecondAdmin(role: string, organizationId: string) {
  if (role.split(",").includes(ADMIN_ROLE) && (await orgPeople(organizationId, { roles: ["admin"], includeDisabled: true })).length > 0) {
    throw new APIError("FORBIDDEN", { message: ONE_ADMIN_MESSAGE });
  }
}

/**
 * True when this user may not sign in: they belong to orgs and every one of their memberships is disabled. Disabled in
 * one org, they keep signing in to their others (that org's access is refused per request: lib/org.ts, assertNotDisabledIn).
 */
export async function isDisabledUser(userId: string) {
  const memberships = await db.member.findMany({ where: { userId }, select: { disabledAt: true } });
  return memberships.length > 0 && memberships.every((member) => member.disabledAt !== null);
}

/** Refuses a session in an org where this person's membership is disabled. */
export async function assertNotDisabledIn(userId: string, orgId: string) {
  const member = await orgPerson(orgId, { userId });
  if (member?.disabled) throw new MemberError(DISABLED_MESSAGE, 403);
}

/**
 * Disables or re-enables a member in one org. Disabling revokes their twin assignments and pending role-play invites
 * there and ends their open sessions there; it signs them out when that was their last enabled membership. Past
 * sessions and reports stay. Re-enabling only lets them sign in again
 * (revoked access is re-granted by assigning again). The admin and yourself cannot be disabled.
 */
export async function setMemberDisabled(input: { orgId: string; memberId: string; actorUserId: string; disabled: boolean }) {
  const person = await orgPerson(input.orgId, { memberId: input.memberId });
  if (!person) throw new MemberError("Member not found", 404);
  const member = { id: person.memberId, userId: person.userId, role: person.role, disabledAt: person.disabledAt };
  if (!input.disabled) {
    await db.member.update({ where: { id: member.id }, data: { disabledAt: null } });
    return;
  }
  if (member.role === ADMIN_ROLE) throw new MemberError("The admin cannot be disabled");
  if (member.userId === input.actorUserId) throw new MemberError("You cannot disable yourself");
  if (member.disabledAt) return;

  const elsewhere = await db.member.count({ where: { userId: member.userId, disabledAt: null, id: { not: member.id } } });
  await db.$transaction([
    db.member.update({ where: { id: member.id }, data: { disabledAt: new Date() } }),
    ...(elsewhere ? [] : [db.session.deleteMany({ where: { userId: member.userId } })]),
    db.twinAssignment.updateMany({
      where: { orgId: input.orgId, status: "active", userId: member.userId },
      data: { status: "revoked" },
    }),
    db.rolePlayAssignment.updateMany({
      where: { orgId: input.orgId, status: "pending", memberId: member.id },
      data: { status: "cancelled" },
    }),
    db.interviewSession.updateMany({
      where: { orgId: input.orgId, userId: member.userId, status: "assigned" },
      data: { status: "revoked", runtimeTokenHash: null },
    }),
  ]);
  // Live calls: close the LiveKit room and keep what was said (status abandoned, like any other ended call).
  const open = await db.interviewSession.findMany({
    where: { orgId: input.orgId, userId: member.userId, status: { in: ["activating", "active"] } },
    select: { id: true },
  });
  for (const session of open) await closeInterviewSession(session.id, "abandoned");
}

/**
 * A member who moved to admin or team keeps no learner assignments (specs/people.md rule 7): their twin and role-play
 * assignments in that org are removed (sessions keep their history; the session's link to the assignment is cleared).
 */
export async function dropLearnerAssignments(orgId: string, memberId: string) {
  const person = await orgPerson(orgId, { memberId });
  if (!person) return;
  await db.$transaction([
    db.twinAssignment.deleteMany({ where: { orgId, userId: person.userId } }),
    db.rolePlayAssignment.deleteMany({ where: { orgId, memberId } }),
  ]);
}

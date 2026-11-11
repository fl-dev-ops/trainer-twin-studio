import { orgPerson, PeopleError, peopleLock, type PersonRole } from "@/lib/org-people";
import { db, withLock } from "@/lib/db";
import { refusals } from "@/lib/errors";
import { ADMIN_ROLE, LEARNER_ROLE, TEAM_ROLE } from "@/lib/roles";
import { closeInterviewSession } from "@/lib/session-lifecycle";

export { ADMIN_ROLE };

export const memberRefusals = {
  adminFixed: () => new PeopleError("admin_fixed", "The admin's role can't be changed and the admin can't be disabled.", 403),
  selfDisable: () => new PeopleError("self_disable", "You can't disable yourself.", 400),
};

/**
 * True when this user may not sign in: they belong to orgs and every one of their memberships is disabled. Disabled in
 * one org, they keep signing in to their others (that org's access is refused per request: lib/org.ts, assertNotDisabledIn).
 */
export async function isDisabledUser(userId: string) {
  const memberships = await db.member.findMany({ where: { userId }, select: { disabledAt: true } });
  return memberships.length > 0 && memberships.every((member) => member.disabledAt !== null);
}

/** Refuses a session in an org where this person's membership is disabled (member_disabled). */
export async function assertNotDisabledIn(userId: string, orgId: string) {
  const member = await orgPerson(orgId, { userId });
  if (member?.disabled) throw refusals.memberDisabled();
}

/**
 * Disables or re-enables a member in one org (specs/people.md rule 18), under the org's people lock. Disabling revokes
 * their active twin assignments, pending role plays and not-yet-started sessions there, signs them out when no enabled
 * membership is left, and ends any call still running (also on a repeat disable, so a call that failed to end is
 * retried; one failing never stops the others). Past sessions and reports stay. Re-enabling restores the membership
 * only. The admin and yourself can't be disabled.
 */
export async function setMemberDisabled(input: { orgId: string; memberId: string; actorUserId: string; disabled: boolean }) {
  const person = await withLock([peopleLock(input.orgId)], async (tx) => {
    const person = await orgPerson(input.orgId, { memberId: input.memberId }, tx);
    if (!person) throw refusals.notFound();
    if (!input.disabled) {
      if (person.disabled) await tx.member.update({ where: { id: person.memberId }, data: { disabledAt: null } });
      return person;
    }
    if (person.role === ADMIN_ROLE) throw memberRefusals.adminFixed();
    if (person.userId === input.actorUserId) throw memberRefusals.selfDisable();
    if (person.disabled) return person;
    const elsewhere = await tx.member.count({ where: { userId: person.userId, disabledAt: null, id: { not: person.memberId } } });
    await tx.member.update({ where: { id: person.memberId }, data: { disabledAt: new Date() } });
    if (!elsewhere) await tx.session.deleteMany({ where: { userId: person.userId } });
    await tx.twinAssignment.updateMany({ where: { orgId: input.orgId, status: "active", userId: person.userId }, data: { status: "revoked" } });
    await tx.rolePlayAssignment.updateMany({ where: { orgId: input.orgId, status: { in: ["pending", "used"] }, memberId: person.memberId }, data: { status: "cancelled" } });
    await tx.interviewSession.updateMany({
      where: { orgId: input.orgId, userId: person.userId, status: "assigned" },
      data: { status: "revoked", runtimeTokenHash: null },
    });
    return person;
  });
  if (!input.disabled) return;
  // Calls in progress: close the LiveKit room and keep what was said (status abandoned, like any other ended call).
  const open = await db.interviewSession.findMany({
    where: { orgId: input.orgId, userId: person.userId, status: { in: ["activating", "active"] } },
    select: { id: true },
  });
  const failed = (await Promise.allSettled(open.map((session) => closeInterviewSession(session.id, "abandoned")))).filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed.length) {
    console.error("[members] could not end calls after disabling:", failed.map((result) => result.reason));
    throw new PeopleError("calls_not_ended", `Disabled, but ${failed.length} call(s) in progress could not be ended yet. Disable again to retry.`, 500);
  }
}

/**
 * Moves a member between team and learner (specs/people.md rule 19; staff only, scripts/set-member-role.ts), under the
 * org's people lock. Becoming team removes their learner assignments in the same transaction (sessions keep their
 * history). The admin's role never changes and nobody becomes admin this way.
 */
export async function changeMemberRole(input: { orgId: string; email: string; role: Exclude<PersonRole, "admin"> }) {
  if (input.role !== TEAM_ROLE && input.role !== LEARNER_ROLE) throw memberRefusals.adminFixed();
  return withLock([peopleLock(input.orgId)], async (tx) => {
    const person = await orgPerson(input.orgId, { email: input.email }, tx);
    if (!person) throw refusals.notFound();
    if (person.role === ADMIN_ROLE) throw memberRefusals.adminFixed();
    if (person.role === input.role) return { before: person.role, after: person.role };
    await tx.member.update({ where: { id: person.memberId }, data: { role: input.role } });
    if (input.role === TEAM_ROLE) {
      await tx.twinAssignment.deleteMany({ where: { orgId: input.orgId, userId: person.userId } });
      await tx.rolePlayAssignment.deleteMany({ where: { orgId: input.orgId, memberId: person.memberId } });
    }
    return { before: person.role, after: input.role };
  });
}

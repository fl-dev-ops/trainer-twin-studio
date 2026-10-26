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
  if (role.split(",").includes(ADMIN_ROLE) && (await db.member.count({ where: { organizationId, role: ADMIN_ROLE } })) > 0) {
    throw new APIError("FORBIDDEN", { message: ONE_ADMIN_MESSAGE });
  }
}

/** True when this user's membership is disabled (they may not sign in). */
export async function isDisabledUser(userId: string) {
  return Boolean(await db.member.findFirst({ where: { userId, disabledAt: { not: null } }, select: { id: true } }));
}

/**
 * Disables or re-enables a member. Disabling signs them out, revokes their twin assignments and pending role-play
 * invites, and ends their open sessions; past sessions and reports stay. Re-enabling only lets them sign in again
 * (revoked access is re-granted by assigning again). The admin and yourself cannot be disabled.
 */
export async function setMemberDisabled(input: { orgId: string; memberId: string; actorUserId: string; disabled: boolean }) {
  const member = await db.member.findFirst({
    where: { id: input.memberId, organizationId: input.orgId },
    select: { id: true, userId: true, role: true, disabledAt: true, user: { select: { email: true } } },
  });
  if (!member) throw new MemberError("Member not found", 404);
  if (!input.disabled) {
    await db.member.update({ where: { id: member.id }, data: { disabledAt: null } });
    return;
  }
  if (member.role === ADMIN_ROLE) throw new MemberError("The admin cannot be disabled");
  if (member.userId === input.actorUserId) throw new MemberError("You cannot disable yourself");
  if (member.disabledAt) return;

  const email = member.user.email.toLowerCase();
  await db.$transaction([
    db.member.update({ where: { id: member.id }, data: { disabledAt: new Date() } }),
    db.session.deleteMany({ where: { userId: member.userId } }),
    db.twinAssignment.updateMany({
      where: { orgId: input.orgId, status: "active", OR: [{ userId: member.userId }, { recipientEmail: email }] },
      data: { status: "revoked" },
    }),
    db.rolePlayAssignment.updateMany({
      where: { orgId: input.orgId, status: "pending", OR: [{ memberId: member.id }, { recipientEmail: email }] },
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

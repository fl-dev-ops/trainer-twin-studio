import { randomUUID } from "node:crypto";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { sendInvitationEmail } from "@/lib/email";
import { learnerInviteUrl } from "@/lib/invite/links";
import { giveStartingMinutes, MinutesError } from "@/lib/minutes";
import { LEARNER_ROLE, STUDIO_ROLES, studioEmails } from "@/lib/org";

/** Org invitations: learners invited to an org from Settings › Users and from the REST API. */

export class InviteError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Settings › Users: invites learners with their starting credits. The credits are given first, all or nothing, so
 * nobody is invited when the balance can't cover them; someone who already has credits keeps theirs. Then one
 * invitation each through Better Auth (its hooks send the email: lib/invite/org-hooks.ts); failures come back per email.
 */
export async function inviteLearners(input: { orgId: string; actorUserId: string; emails: string[]; minutes: number; headers: Headers }) {
  const staff = await studioEmails(input.orgId, input.emails);
  if (staff.size) throw new MinutesError(`Already on the studio team: ${[...staff].join(", ")}`, 400);
  await giveStartingMinutes({ orgId: input.orgId, emails: input.emails, minutes: input.minutes, actorUserId: input.actorUserId });
  const failed: { email: string; message: string }[] = [];
  for (const email of input.emails) {
    await auth.api.createInvitation({ headers: input.headers, body: { email, role: LEARNER_ROLE, organizationId: input.orgId } })
      .catch((error: unknown) => failed.push({ email, message: error instanceof Error ? error.message : "Could not create the invite" }));
  }
  return { invited: input.emails.length - failed.length, failed };
}

/**
 * REST API (POST /api/v1/users): invites one learner as the API key's trainer, or refreshes their pending invitation
 * (48 hours from now), and emails them their org's home page. Throws InviteError with the HTTP status to answer.
 */
export async function inviteLearnerByApi(input: { org: { id: string; slug: string; name: string }; actorUserId?: string | null; email: string }) {
  const email = input.email.toLowerCase();
  const existingMember = await db.member.findFirst({
    where: { organizationId: input.org.id, user: { email } },
    select: { id: true, disabledAt: true },
  });
  if (existingMember?.disabledAt) throw new InviteError("User was removed (disabled); re-enable them in Settings → Team and users", 409);
  if (existingMember) throw new InviteError("User is already an organization member", 409);

  const inviter = await db.member.findFirst({
    where: { organizationId: input.org.id, role: { in: [...STUDIO_ROLES] }, ...(input.actorUserId ? { userId: input.actorUserId } : {}) },
    select: { userId: true, user: { select: { name: true } } },
  });
  if (!inviter) throw new InviteError("API key creator is no longer an organization trainer", 403);
  // A new learner gets their starting minutes from the org balance (once; re-inviting is free).
  try {
    await giveStartingMinutes({ orgId: input.org.id, emails: [email], actorUserId: inviter.userId });
  } catch (error) {
    if (error instanceof MinutesError) throw new InviteError(error.message, 409);
    throw error;
  }

  const existingInvitation = await db.invitation.findFirst({
    where: { organizationId: input.org.id, email, status: "pending" },
    select: { id: true },
  });
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const invitation = existingInvitation
    ? await db.invitation.update({ where: { id: existingInvitation.id }, data: { expiresAt, inviterId: inviter.userId } })
    : await db.invitation.create({
        data: { id: randomUUID(), organizationId: input.org.id, email, role: LEARNER_ROLE, status: "pending", expiresAt, inviterId: inviter.userId },
      });
  const delivery = await sendInvitationEmail({
    to: email,
    organizationName: input.org.name,
    inviterName: inviter.user.name,
    inviteUrl: learnerInviteUrl(input.org.slug),
  });
  return { invitation, created: !existingInvitation, emailSent: delivery.success };
}

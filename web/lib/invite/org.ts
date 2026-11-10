import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { deliverInviteEmail, queueInviteEmails } from "@/lib/schedule-invite-emails";
import type { InviteEmail } from "@/workflows/invite-emails";
import { learnerInviteUrl, orgInviteUrl } from "@/lib/invite/links";
import { giveStartingMinutes, MinutesError } from "@/lib/minutes";
import { LEARNER_ROLE, STUDIO_ROLES, studioEmails } from "@/lib/org";

/** Org invitations: learners invited to an org from Settings › Users and from the REST API. */

export class InviteError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** How long an org invitation stays open (Better Auth's default, also used by the REST API). */
const INVITATION_HOURS = 48;

/**
 * Opens (or refreshes, 48 hours from now) one learner's pending invitation to the org, as `inviterId`. Refused for
 * someone already in the org, or removed from it. Shared by Settings › Users and the REST API.
 */
async function openLearnerInvitation(orgId: string, email: string, inviterId: string) {
  const member = await db.member.findFirst({ where: { organizationId: orgId, user: { email } }, select: { disabledAt: true } });
  if (member?.disabledAt) throw new InviteError("User was removed (disabled); re-enable them in Settings → Team and users", 409);
  if (member) throw new InviteError("User is already an organization member", 409);
  const existing = await db.invitation.findFirst({ where: { organizationId: orgId, email, status: "pending" }, select: { id: true } });
  const expiresAt = new Date(Date.now() + INVITATION_HOURS * 60 * 60 * 1000);
  const invitation = existing
    ? await db.invitation.update({ where: { id: existing.id }, data: { expiresAt, inviterId } })
    : await db.invitation.create({ data: { id: randomUUID(), organizationId: orgId, email, role: LEARNER_ROLE, status: "pending", expiresAt, inviterId } });
  return { invitation, created: !existing };
}

export type OrgInviteInput = { org: { id: string; slug: string; name: string }; by: { id: string; name: string }; emails: string[]; minutes: number };

/**
 * Settings › Users: invites learners with their starting credits. The credits are given first, all or nothing
 * (MinutesError when the balance can't cover them; someone who already has credits keeps theirs), then one invitation
 * each; failures come back per email, with the emails to send. The invite-org-learners workflow's first step
 * (workflows/invite-org-learners.ts).
 */
export async function inviteOrgLearners(input: OrgInviteInput) {
  const emails = [...new Set(input.emails.map((email) => email.trim().toLowerCase()))];
  const staff = await studioEmails(input.org.id, emails);
  if (staff.size) throw new MinutesError(`Already on the studio team: ${[...staff].join(", ")}`, 400);
  await giveStartingMinutes({ orgId: input.org.id, emails, minutes: input.minutes, actorUserId: input.by.id });
  const failed: { email: string; message: string }[] = [];
  const invited: InviteEmail[] = [];
  for (const email of emails) {
    try {
      const { invitation } = await openLearnerInvitation(input.org.id, email, input.by.id);
      invited.push({
        kind: "invitation",
        // One email per invitation and expiry: a retry can't send it twice, inviting again sends a new one.
        idempotencyKey: `invitation:${invitation.id}:${invitation.expiresAt.getTime()}`,
        args: { to: email, organizationName: input.org.name, inviterName: input.by.name, inviteUrl: orgInviteUrl(invitation, input.org.slug) },
      });
    } catch (error) {
      failed.push({ email, message: error instanceof Error ? error.message : "Could not create the invite" });
    }
  }
  return { invited: invited.length, failed, emails: invited };
}

/** Both parts here, without the workflow (when it can't start): invite, then email. */
export async function inviteLearners(input: OrgInviteInput) {
  const { emails, ...result } = await inviteOrgLearners(input);
  return { ...result, ...(await queueInviteEmails(input.org.id, emails)) };
}

/**
 * REST API (POST /api/v1/users): invites one learner as the API key's trainer, or refreshes their pending invitation
 * (48 hours from now), and emails them their org's home page. Throws InviteError with the HTTP status to answer.
 */
export async function inviteLearnerByApi(input: { org: { id: string; slug: string; name: string }; actorUserId?: string | null; email: string }) {
  const email = input.email.toLowerCase();
  const member = await db.member.findFirst({ where: { organizationId: input.org.id, user: { email } }, select: { disabledAt: true } });
  if (member?.disabledAt) throw new InviteError("User was removed (disabled); re-enable them in Settings → Team and users", 409);
  if (member) throw new InviteError("User is already an organization member", 409);

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

  const { invitation, created } = await openLearnerInvitation(input.org.id, email, inviter.userId);
  // Sent now (the response says whether it went); a failure keeps being retried in the background, once per refresh.
  const delivery = await deliverInviteEmail({
    kind: "invitation",
    idempotencyKey: `invitation:${invitation.id}:${invitation.expiresAt.getTime()}`,
    args: { to: email, organizationName: input.org.name, inviterName: inviter.user.name, inviteUrl: learnerInviteUrl(input.org.slug) },
  });
  return { invitation, created, emailSent: delivery.sent };
}

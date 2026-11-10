import { APIError } from "better-auth/api";
import { deliverInviteEmail } from "@/lib/schedule-invite-emails";
import { orgInviteUrl } from "@/lib/invite/links";
import { giveStartingMinutes, MinutesError } from "@/lib/minutes";

/**
 * What Better Auth's organization plugin calls around an org invitation (lib/auth.ts). Must not import lib/auth or
 * lib/org: lib/org imports lib/auth, which imports this.
 */

/** Before an invitation is created: a learner gets their starting credits from the org balance (once; a resend is free). */
export async function beforeOrgInvitation(invitation: { role: string; email: string; inviterId: string }, orgId: string) {
  if (invitation.role !== "user") return; // LEARNER_ROLE
  await giveStartingMinutes({ orgId, emails: [invitation.email], actorUserId: invitation.inviterId }).catch((error: unknown) => {
    if (error instanceof MinutesError) throw new APIError("BAD_REQUEST", { message: error.message });
    throw error;
  });
}

/**
 * The invitation email (Settings › Team invites go through Better Auth): learners get their org's home page, studio
 * invites the auth invite page (lib/invite/links.ts). Sent now; a failure keeps being retried in the background by
 * the send-invite-emails workflow (workflows/invite-emails.ts). Each send (or "send again") has its own key.
 */
export async function emailOrgInvitation(data: {
  id: string;
  email: string;
  role: string;
  organization: { name: string; slug: string };
  inviter: unknown;
}) {
  const inviter = data.inviter as { user?: { name?: string }; name?: string } | undefined;
  await deliverInviteEmail({
    kind: "invitation",
    idempotencyKey: `invitation:${data.id}:${Date.now()}`,
    args: {
      to: data.email,
      organizationName: data.organization.name,
      inviterName: inviter?.user?.name || inviter?.name || "Your team",
      inviteUrl: orgInviteUrl({ id: data.id, role: data.role }, data.organization.slug),
    },
  });
}

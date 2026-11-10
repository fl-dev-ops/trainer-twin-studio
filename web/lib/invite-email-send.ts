import { sendInvitationEmail, sendRolePlayAssignmentEmail, sendTwinAssignmentEmail } from "@/lib/email";
import type { InviteEmail } from "@/workflows/invite-emails";

/** Sends one invite email now (the send-invite-emails workflow's step, and its fallbacks in lib/schedule-invite-emails.ts). */
export function sendInviteEmailNow(email: InviteEmail, idempotencyKey?: string) {
  switch (email.kind) {
    case "twin": return sendTwinAssignmentEmail({ ...email.args, idempotencyKey });
    case "roleplay": return sendRolePlayAssignmentEmail({ ...email.args, idempotencyKey });
    case "invitation": return sendInvitationEmail({ ...email.args, idempotencyKey });
  }
}

import { start } from "workflow/api";
import { sendInviteEmailNow } from "@/lib/invite-email-send";
import { progressToken } from "@/lib/run-progress";
import { type InviteEmail, sendInviteEmails } from "@/workflows/invite-emails";

/**
 * The assign screens' emails: sent by the send-invite-emails workflow (workflows/invite-emails.ts), each retried on
 * its own; returns a token the screen follows (app/api/runs/[token]). When the workflow can't start, they're sent
 * right here as before, so nobody misses their link; emailFailures then counts what failed.
 */
export async function queueInviteEmails(orgId: string, emails: InviteEmail[]): Promise<{ emailFailures: number; emailsQueued: number; emailProgress?: string }> {
  if (!emails.length) return { emailFailures: 0, emailsQueued: 0 };
  try {
    const run = await start(sendInviteEmails, [emails]);
    return { emailFailures: 0, emailsQueued: emails.length, emailProgress: progressToken(orgId, run.runId) };
  } catch (error) {
    console.error("[invite-emails] workflow did not start; sending now:", error instanceof Error ? error.message : error);
    const results = await Promise.all(emails.map((email) => sendInviteEmailNow(email)));
    return { emailFailures: results.filter(({ success }) => !success).length, emailsQueued: 0 };
  }
}

/**
 * The public API's emails (its responses promise `emailSent`): sent now; when that fails, the send-invite-emails
 * workflow keeps retrying in the background with the same idempotency key, so the person gets it once.
 */
export async function deliverInviteEmail(email: InviteEmail & { idempotencyKey: string }): Promise<{ sent: boolean }> {
  const result = await sendInviteEmailNow(email, email.idempotencyKey);
  if (result.success) return { sent: true };
  try {
    await start(sendInviteEmails, [[email]]);
  } catch (error) {
    console.error("[invite-emails] could not queue a retry:", error instanceof Error ? error.message : error);
  }
  return { sent: false };
}

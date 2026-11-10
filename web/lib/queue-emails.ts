import { start } from "workflow/api";
import { sendEmailNow } from "@/lib/send-email-now";
import { progressToken } from "@/lib/run-progress";
import { deliverEmails, type OutboundEmail } from "@/workflows/send-emails";

/**
 * An action's emails: sent by the send-emails workflow (workflows/send-emails.ts), each retried on its own; returns a
 * token the screen follows (app/api/runs/[token]). When the workflow can't start, they're sent right here, so nobody
 * misses theirs; emailFailures then counts what failed.
 */
export async function queueEmails(orgId: string, emails: OutboundEmail[]): Promise<{ emailFailures: number; emailsQueued: number; emailProgress?: string }> {
  if (!emails.length) return { emailFailures: 0, emailsQueued: 0 };
  try {
    const run = await start(deliverEmails, [emails]);
    return { emailFailures: 0, emailsQueued: emails.length, emailProgress: progressToken(orgId, run.runId) };
  } catch (error) {
    console.error("[send-emails] workflow did not start; sending now:", error instanceof Error ? error.message : error);
    // Each email's own key, so it still goes out once if the same action is retried.
    const results = await Promise.all(emails.map((email) => sendEmailNow(email, email.idempotencyKey)));
    return { emailFailures: results.filter(({ success }) => !success).length, emailsQueued: 0 };
  }
}

/**
 * The public API's emails (its responses promise `emailSent`): sent now; when that fails, the send-emails workflow
 * keeps retrying in the background with the same idempotency key, so the person gets it once.
 */
export async function deliverEmail(email: OutboundEmail & { idempotencyKey: string }): Promise<{ sent: boolean }> {
  const result = await sendEmailNow(email, email.idempotencyKey);
  if (result.success) return { sent: true };
  try {
    await start(deliverEmails, [[email]]);
  } catch (error) {
    console.error("[send-emails] could not queue a retry:", error instanceof Error ? error.message : error);
  }
  return { sent: false };
}

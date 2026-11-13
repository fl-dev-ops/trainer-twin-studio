import { FatalError, getStepMetadata, getWritable } from "workflow";
import { sendEmailNow } from "@/lib/send-email-now";
import type { EmailProgress, OutboundEmail } from "../send-emails";

/** Steps of the send-emails workflow (../send-emails.ts). Progress goes to the run's stream (app/api/runs/[token]). */

async function report(event: EmailProgress) {
  const writer = getWritable<EmailProgress>().getWriter();
  await writer.write(event);
  writer.releaseLock();
}

/**
 * One email. Resend failures are retried (step default backoff). The Resend idempotency key is the email's own (when
 * it was first tried outside the workflow) or this step's id, so a retry after a lost reply never sends it twice. No
 * Resend key configured: no point retrying.
 */
export async function sendOne(email: OutboundEmail): Promise<void> {
  "use step";
  const result = await sendEmailNow(email, email.idempotencyKey ?? getStepMetadata().stepId);
  if (!result.success) {
    const message = `Email to ${email.args.to}: ${result.error}`;
    if (result.error === "RESEND_API_KEY is not set") throw new FatalError(message);
    // Refused for good (a bad address, the same key with a changed body): retrying sends nothing (practice rule 28).
    const status = "status" in result && typeof result.status === "number" ? result.status : null;
    if (status !== null && status >= 400 && status < 500 && status !== 429) throw new FatalError(message);
    throw new Error(message);
  }
  await report({ to: email.args.to, status: "sent" });
}
sendOne.maxRetries = 4;

/** An email that still failed after its retries. */
export async function markFailed(to: string): Promise<void> {
  "use step";
  await report({ to, status: "failed" });
}

/** Last event, then the stream ends (readers stop waiting). */
export async function finish(summary: { sent: number; failed: string[] }): Promise<void> {
  "use step";
  await report({ status: "done", ...summary });
  await getWritable<EmailProgress>().close();
}

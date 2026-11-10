import { FatalError, getStepMetadata, getWritable } from "workflow";
import { sendRolePlayAssignmentEmail, sendTwinAssignmentEmail } from "@/lib/email";
import type { AssignmentEmail, EmailProgress } from "./assignment-emails";

/** Steps of the assignment-emails workflow. Progress goes to the run's stream (app/api/runs/[token]). */

async function report(event: EmailProgress) {
  const writer = getWritable<EmailProgress>().getWriter();
  await writer.write(event);
  writer.releaseLock();
}

/**
 * One invite email. Resend failures are retried (step default backoff); the step id is the Resend idempotency key, so
 * a retry after a lost reply doesn't send it twice. No Resend key configured: no point retrying.
 */
export async function sendOne(email: AssignmentEmail): Promise<void> {
  "use step";
  const { stepId } = getStepMetadata();
  const result = email.kind === "twin"
    ? await sendTwinAssignmentEmail({ ...email.args, idempotencyKey: stepId })
    : await sendRolePlayAssignmentEmail({ ...email.args, idempotencyKey: stepId });
  if (!result.success) {
    const message = `Invite to ${email.args.to}: ${result.error}`;
    if (result.error === "RESEND_API_KEY is not set") throw new FatalError(message);
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

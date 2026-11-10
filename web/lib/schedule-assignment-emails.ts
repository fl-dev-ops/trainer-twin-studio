import { start } from "workflow/api";
import { sendRolePlayAssignmentEmail, sendTwinAssignmentEmail } from "@/lib/email";
import { progressToken } from "@/lib/run-progress";
import { type AssignmentEmail, sendAssignmentEmails } from "@/workflows/assignment-emails";

/**
 * Sends an assignment's invite emails through the assignment-emails workflow (each retried on its own) and returns a
 * token the assign screen follows (app/api/runs/[token]). When the workflow can't start, they're sent right here as
 * before, so nobody misses their link; emailFailures then counts what failed.
 */
export async function queueAssignmentEmails(orgId: string, emails: AssignmentEmail[]): Promise<{ emailFailures: number; emailsQueued: number; emailProgress?: string }> {
  if (!emails.length) return { emailFailures: 0, emailsQueued: 0 };
  try {
    const run = await start(sendAssignmentEmails, [emails]);
    return { emailFailures: 0, emailsQueued: emails.length, emailProgress: progressToken(orgId, run.runId) };
  } catch (error) {
    console.error("[assignment-emails] workflow did not start; sending now:", error instanceof Error ? error.message : error);
    const results = await Promise.all(emails.map((email) => email.kind === "twin" ? sendTwinAssignmentEmail(email.args) : sendRolePlayAssignmentEmail(email.args)));
    return { emailFailures: results.filter(({ success }) => !success).length, emailsQueued: 0 };
  }
}

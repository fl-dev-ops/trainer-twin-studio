import type { sendRolePlayAssignmentEmail, sendTwinAssignmentEmail } from "@/lib/email";
import { finish, markFailed, sendOne } from "./assignment-emails-steps";

export type AssignmentEmail =
  | { kind: "twin"; args: Omit<Parameters<typeof sendTwinAssignmentEmail>[0], "idempotencyKey"> }
  | { kind: "roleplay"; args: Omit<Parameters<typeof sendRolePlayAssignmentEmail>[0], "idempotencyKey"> };

/** What the assign screens see while the invites go out (one event per email, then "done"). */
export type EmailProgress =
  | { to: string; status: "sent" | "failed" }
  | { status: "done"; sent: number; failed: string[] };

/**
 * The invite emails of one assignment (twin or role play): each sent and retried on its own, so one failing address
 * doesn't hold up or lose the others. The people are already assigned with their minutes when this starts
 * (lib/invite/twin.ts, roleplay.ts); this only delivers their links.
 */
export async function sendAssignmentEmails(emails: AssignmentEmail[]) {
  "use workflow";
  const failed: string[] = [];
  for (const email of emails) {
    try {
      await sendOne(email);
    } catch {
      failed.push(email.args.to);
      await markFailed(email.args.to);
    }
  }
  const summary = { sent: emails.length - failed.length, failed };
  await finish(summary);
  return summary;
}

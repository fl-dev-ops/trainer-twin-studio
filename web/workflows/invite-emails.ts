// Workflow: send invite emails.
// Delivers the emails of one assignment or invitation (twin, role play, org invite), each retried on its own so one
// bad address doesn't hold up the rest; the assign screens follow it live. Started by lib/schedule-invite-emails.ts.

import type { sendInvitationEmail, sendRolePlayAssignmentEmail, sendTwinAssignmentEmail } from "@/lib/email";
import { finish, markFailed, sendOne } from "./steps/invite-emails";

type Args<T extends (input: never) => unknown> = Omit<Parameters<T>[0], "idempotencyKey">;

/** One email. `idempotencyKey`: set when it was already tried outside the workflow, so a retry can't send it twice. */
export type InviteEmail = (
  | { kind: "twin"; args: Args<typeof sendTwinAssignmentEmail> }
  | { kind: "roleplay"; args: Args<typeof sendRolePlayAssignmentEmail> }
  | { kind: "invitation"; args: Args<typeof sendInvitationEmail> }
) & { idempotencyKey?: string };

/** What the assign screens see while the emails go out (one event per email, then "done"). */
export type EmailProgress =
  | { to: string; status: "sent" | "failed" }
  | { status: "done"; sent: number; failed: string[] };

/** The people are already assigned or invited when this starts; this only delivers their emails. */
export async function sendInviteEmails(emails: InviteEmail[]) {
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

// Workflow: send emails.
// Delivers the emails of one action (people added, a twin or role play given, credits added: specs/people.md rule
// 11), each retried on its own so one bad address doesn't hold up the rest; the screens follow it live. Started by
// lib/queue-emails.ts.

import type { OrgCreditsEmailArgs, PersonEmailArgs } from "@/lib/email";
import { finish, markFailed, sendOne } from "./steps/send-emails";

/** One email. `idempotencyKey`: set when it was already tried outside the workflow, so a retry can't send it twice. */
export type OutboundEmail = (
  | { kind: "person"; args: Omit<PersonEmailArgs, "idempotencyKey"> }
  | { kind: "orgCredits"; args: Omit<OrgCreditsEmailArgs, "idempotencyKey"> }
) & { idempotencyKey?: string };

/** What the screens see while the emails go out (one event per email, then "done"). */
export type EmailProgress =
  | { to: string; status: "sent" | "failed" }
  | { status: "done"; sent: number; failed: string[] };

/** The action is already done when this starts; this only delivers its emails. */
export async function deliverEmails(emails: OutboundEmail[]) {
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

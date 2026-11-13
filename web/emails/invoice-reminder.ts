/** Renewal reminder. Sent once on the UTC day before an unpaid renewal's due date, with its invoice PDF. */
import { renderBillingEmail, type BillingEmailArgs } from "./billing-shared";

export function invoiceReminderEmail(args: BillingEmailArgs) {
  return renderBillingEmail(args, {
    subject: `Reminder: invoice ${args.invoiceNumber} (${args.amount}) is due tomorrow`,
    title: "Payment due tomorrow",
    message: "Pay by tomorrow to avoid pausing new calls and learner credit assignments. Your invoice is attached.",
    note: "Already paid? Reply to this email so we can check.",
  });
}

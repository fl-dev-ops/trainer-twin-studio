/** Plan paused. Sent when an unpaid current-subscription renewal becomes overdue, with its invoice PDF. */
import { renderBillingEmail, type BillingEmailArgs } from "./billing-shared";

export function planPausedEmail(args: BillingEmailArgs) {
  return renderBillingEmail(args, {
    subject: `Your TrainerTwin plan is paused: invoice ${args.invoiceNumber} is overdue`,
    title: "Your plan is paused",
    message: "New calls and learner credit assignments are paused. Pay your overdue invoices to resume. Your credits and history are kept.",
    note: "Your invoice is attached. Already paid? Reply to this email so we can check.",
  });
}

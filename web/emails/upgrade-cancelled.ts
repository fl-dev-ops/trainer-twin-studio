/** Upgrade cancelled. Sent after an overdue unpaid first paid-plan invoice is voided; Trial remains active. */
import { renderBillingEmail, type BillingEmailArgs } from "./billing-shared";

export function upgradeCancelledEmail(args: BillingEmailArgs) {
  return renderBillingEmail(args, {
    subject: "Your upgrade to the TrainerTwin Paid plan was cancelled",
    title: "Upgrade cancelled",
    message: "Your upgrade wasn't paid by its due date, so it was cancelled. You're still on the Trial plan.",
    note: "Want to upgrade again? Reply to this email.",
  });
}

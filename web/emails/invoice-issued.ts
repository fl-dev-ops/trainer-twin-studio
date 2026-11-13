/** Invoice issued. Sent for any finalized invoice above $0; includes its PDF and payment guidance. */
import { renderBillingEmail, type BillingEmailArgs } from "./billing-shared";

export function invoiceIssuedEmail(args: BillingEmailArgs) {
  return renderBillingEmail(args, {
    subject: `Your TrainerTwin invoice ${args.invoiceNumber}: ${args.amount} due ${args.dueDate}`,
    title: "Your invoice is ready",
    message: "Please pay by the due date below. Your invoice is attached.",
  });
}

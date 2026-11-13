/** Payment received. Sent once for a paid invoice; preserves its plan/credit outcome and attaches receipt + invoice. */
import { renderBillingEmail, type BillingEmailArgs } from "./billing-shared";

export function invoicePaidEmail(args: BillingEmailArgs) {
  return renderBillingEmail(args, {
    subject: `Payment received for invoice ${args.invoiceNumber}: thank you`,
    title: "Payment received",
    message: "Thank you. Your payment is confirmed.",
    note: "Your receipt and invoice are attached.",
  });
}

import { ensurePaymentLink } from "@/lib/billing/razorpay";
import {
  invoiceForWorkflow,
  invoiceIssuedEmail,
  invoiceOverdue,
  invoicePaid,
  invoiceReminder,
} from "@/lib/billing/billing";

/** Steps of the invoice-issued and invoice-paid workflows (lib/billing/billing.ts). Retried on failure; safe to repeat. */

/** The invoice as Meteroid has it now: kind, status, due date (YYYY-MM-DD). */
export async function readInvoice(invoiceId: string) {
  "use step";
  return invoiceForWorkflow(invoiceId);
}

/** The invoice's Razorpay payment link, made once (none while Razorpay is off or the org has no phone). */
export async function payLink(invoiceId: string) {
  "use step";
  return ensurePaymentLink(invoiceId);
}

/** Emails the invoice with its PDF, once. */
export async function emailInvoice(invoiceId: string) {
  "use step";
  return invoiceIssuedEmail(invoiceId);
}

/** The day before the due date: a renewal still unpaid gets one reminder. */
export async function remind(invoiceId: string) {
  "use step";
  return invoiceReminder(invoiceId);
}

/** Overdue: a renewal pauses the org, an upgrade is cancelled; paid in the meantime: nothing. */
export async function handleOverdue(invoiceId: string) {
  "use step";
  return (await invoiceOverdue(invoiceId)).action;
}

/** Paid: the plan change or unpause, then the "payment received" email with the receipt. */
export async function handlePaid(invoiceId: string) {
  "use step";
  const result = await invoicePaid(invoiceId);
  return result.paid ? result.kind : null;
}

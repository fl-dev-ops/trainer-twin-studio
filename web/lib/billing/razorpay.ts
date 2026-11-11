import { db } from "@/lib/db";
import type { BillingInvoice } from "@/lib/generated/prisma/client";
import { type BillingDetails } from "@/lib/billing/details";
import { getInvoiceRaw, markInvoicePaid } from "@/lib/billing/meteroid";
import { studioUrl } from "@/lib/invite/links";
import {
  cancelPaymentLink,
  createInvoicePaymentLink,
  fetchPayment,
  fetchPaymentLink,
  paymentLinkByReference,
  RazorpayError,
} from "@/lib/razorpay";

/**
 * Paying invoices online (specs/billing.md rules 27–33): one Razorpay payment link per unpaid invoice; a payment on
 * it marks the Meteroid invoice paid once (the invoice-paid workflow then does the rest, as for any paid invoice); a
 * second payment is recorded as a duplicate for staff to refund; links close when their invoice is voided or paid
 * another way. Razorpay is always on: without its keys (RAZORPAY_KEY_ID / _SECRET) making a link fails, the invoice
 * email goes without Pay now, and the daily check tries again.
 */

type Row = Pick<BillingInvoice, "id" | "orgId" | "number" | "status" | "totalCents" | "currency" | "paymentLinkId" | "paymentLinkUrl">;

/** Where the payer lands after paying: Billing, which shows the payment as it arrives. */
const callbackUrl = (number: string) => `${studioUrl()}billing?paid=${encodeURIComponent(number)}`;

/**
 * The invoice's payment link (rule 27), made once: the link's reference is the invoice id, so a retry that finds
 * Razorpay already has it reuses that one. Null when the invoice isn't unpaid or the org has no phone (Razorpay needs
 * one for card payments in USD).
 */
export async function ensurePaymentLink(invoiceId: string): Promise<string | null> {
  const row = await db.billingInvoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { billing: { select: { billingDetails: true } } } });
  if (row.paymentLinkUrl) return row.paymentLinkUrl;
  if (row.status !== "unpaid" || row.totalCents <= 0) return null;
  const details = row.billing.billingDetails as BillingDetails | null;
  if (!details?.phone) {
    console.error(`[billing] ${row.orgId}: no phone in billing details, so no payment link for ${row.number}`);
    return null;
  }
  let link;
  try {
    link = await createInvoicePaymentLink({
      amount: row.totalCents,
      currency: row.currency,
      description: `TrainerTwin invoice ${row.number}`,
      referenceId: row.id,
      notes: { invoiceId: row.id, invoiceNumber: row.number, orgId: row.orgId },
      customer: { name: details.legalName, email: details.emails[0], contact: details.phone },
      callbackUrl: callbackUrl(row.number),
    });
  } catch (error) {
    // Made by an earlier try that didn't get to save it: Razorpay refuses the same reference twice.
    const existing = error instanceof RazorpayError && error.status === 400 ? await paymentLinkByReference(row.id) : null;
    if (!existing) throw error;
    link = existing;
  }
  await db.billingInvoice.updateMany({ where: { id: row.id, paymentLinkId: null }, data: { paymentLinkId: link.id, paymentLinkUrl: link.short_url } });
  const saved = await db.billingInvoice.findUniqueOrThrow({ where: { id: row.id } });
  // Voided or paid by bank transfer while the link was being made: it mustn't stay payable (rule 32).
  if (saved.status !== "unpaid") {
    await closePaymentLink(saved);
    return null;
  }
  return saved.paymentLinkUrl;
}

/** Rule 32: the invoice was voided or paid another way, so its link can't be paid any more. Best effort. */
export async function closePaymentLink(row: Pick<BillingInvoice, "id" | "number" | "paymentLinkId" | "razorpayPaymentId">) {
  if (!row.paymentLinkId || row.razorpayPaymentId) return;
  try {
    await cancelPaymentLink(row.paymentLinkId);
  } catch (error) {
    // Already paid (then its webhook records a duplicate) or already cancelled: nothing more to do here.
    console.error(`[billing] closing the payment link of ${row.number}:`, error instanceof Error ? error.message : error);
  }
}

export type RazorpayPaidResult =
  | { status: "applied"; invoiceId: string }
  | { status: "duplicate"; invoiceId: string; reason: string }
  | { status: "ignored"; reason: string };

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

/** Records the Razorpay payment (rules 29, 31), in the same transaction as the decision about it. */
async function recordPayment(tx: Tx, row: Row, input: { linkId: string; paymentId: string; amount: number; currency: string }, status: "applied" | "duplicate") {
  const data = { invoiceId: row.id, orgId: row.orgId, paymentLinkId: input.linkId, status, amount: input.amount, currency: input.currency };
  await tx.billingPayment.upsert({ where: { id: input.paymentId }, create: { id: input.paymentId, ...data, paidAt: new Date() }, update: data });
}

/** What Razorpay says the payment cost (INR amount, fee, GST on it, method), when it can say: never overwritten by blanks. */
async function recordFees(paymentId: string) {
  const payment = await fetchPayment(paymentId).catch(() => null);
  if (!payment) return; // the fee report reads it again later
  await db.billingPayment.update({
    where: { id: paymentId },
    data: {
      amountInr: payment.base_amount ?? undefined,
      feeInr: payment.fee ?? undefined,
      taxInr: payment.tax ?? undefined,
      method: payment.method ?? undefined,
      international: payment.international,
      paidAt: new Date(payment.created_at * 1000),
    },
  });
}

/**
 * A payment on an invoice's link (rule 29): checked against the invoice, then the Meteroid invoice is marked paid once,
 * with the Razorpay payment id as its reference. One payment at a time per invoice (a lock), so Razorpay retrying a
 * webhook, or the daily check, never marks it twice. Meteroid already paid by something else, or voided: a duplicate
 * (rule 31). Throws when Meteroid can't be reached (Razorpay retries the webhook).
 */
export async function razorpayInvoicePaid(input: { linkId: string; paymentId: string; amount: number; currency: string }): Promise<RazorpayPaidResult> {
  const row = await db.billingInvoice.findUnique({ where: { paymentLinkId: input.linkId } });
  if (!row) {
    console.error(`[billing] Razorpay payment ${input.paymentId} on an unknown link ${input.linkId}`);
    return { status: "ignored", reason: "unknown link" };
  }
  if (input.amount !== row.totalCents || input.currency !== row.currency) {
    console.error(`[billing] Razorpay payment ${input.paymentId} for ${row.number}: ${input.amount} ${input.currency}, invoice is ${row.totalCents} ${row.currency}`);
    return { status: "ignored", reason: "amount or currency doesn't match the invoice" };
  }
  const result = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`razorpay:${row.id}`}))`;
    const decide = async (status: "applied" | "duplicate", reason?: string) => {
      await recordPayment(tx, row, input, status);
      return status === "applied" ? { status } : { status, reason: reason ?? "" };
    };
    const current = await tx.billingInvoice.findUniqueOrThrow({ where: { id: row.id } });
    // Saved only together with a successful mark (same transaction): this payment is already on the invoice. Meteroid's
    // API can still read "unpaid" for a moment after a mark, so it must not be asked again (a second mark is a second
    // payment in Meteroid).
    if (current.razorpayPaymentId === input.paymentId) return decide("applied");
    if (current.razorpayPaymentId) return decide("duplicate", `already paid by Razorpay payment ${current.razorpayPaymentId}`);
    const invoice = await getInvoiceRaw(row.id);
    const refs = (invoice.transactions ?? []).map((tx) => tx.provider_transaction_id);
    if (refs.includes(input.paymentId)) {
      // Marked by an earlier try whose save didn't happen: record it now.
      await tx.billingInvoice.update({ where: { id: row.id }, data: { razorpayPaymentId: input.paymentId } });
      return decide("applied");
    }
    if (invoice.payment_status === "PAID" || invoice.status === "VOID") {
      return decide("duplicate", invoice.status === "VOID" ? "the invoice was voided" : "the invoice was already paid another way");
    }
    await tx.billingInvoice.update({ where: { id: row.id }, data: { razorpayPaymentId: input.paymentId } });
    await recordPayment(tx, row, input, "applied");
    await markInvoicePaid(row.id, (input.amount / 100).toFixed(2), input.paymentId); // last: nothing after it can roll back
    return { status: "applied" as const };
  }, { timeout: 60_000, maxWait: 30_000 });

  await recordFees(input.paymentId);
  if (result.status === "duplicate") {
    console.error(`[billing] DUPLICATE payment ${input.paymentId} (${input.amount} ${input.currency}) for ${row.number}: ${result.reason}. Refund it in Razorpay.`);
    return { status: "duplicate", invoiceId: row.id, reason: result.reason };
  }
  // The paid workflow (receipt, Paid plan, unpause), as for any paid invoice; it waits for Meteroid to show the payment.
  const { syncInvoice } = await import("@/lib/billing/billing"); // dynamic: billing imports this module
  await syncInvoice(row.id, row.orgId, true);
  return { status: "applied", invoiceId: row.id };
}

/** Rule 33: an unpaid invoice whose link Razorpay says was paid (a lost webhook), settled the same way. */
export async function reconcilePaymentLink(row: Pick<BillingInvoice, "paymentLinkId">) {
  if (!row.paymentLinkId) return null;
  const link = await fetchPaymentLink(row.paymentLinkId);
  const payment = link.status === "paid" ? link.payments?.find((p) => p.status === "captured") ?? link.payments?.[0] : undefined;
  if (!payment) return null;
  return razorpayInvoicePaid({ linkId: link.id, paymentId: payment.payment_id, amount: payment.amount, currency: link.currency });
}

import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { grantMinutes } from "@/lib/meteroid";
import { scheduleOrgSync } from "@/lib/schedule-org-credits";
import { createPaymentLink, fetchInvoice, fetchPaymentLink } from "@/lib/razorpay";

/**
 * Credits an org buys from TrainerTwin, at its own price (CreditPurchase). Two ways in, both through Razorpay:
 * - a payment link we create (scripts/org-payment-link.ts), in INR or USD;
 * - a GST invoice made in the Razorpay Dashboard (its API can't make GST invoices), linked to the org
 *   (scripts/link-invoice.ts).
 * Razorpay's webhook (app/api/razorpay/webhook) then adds the credits to the org in Meteroid when it's paid, once
 * (lib/org-credits.ts). Refunds are not taken back yet: they're logged for a person.
 */

/** Bought credits expire a year after they're paid (pricing decision, 9 Nov 2026). */
const PURCHASE_VALID_DAYS = 365;

export const CURRENCIES = ["INR", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];

export class PurchaseError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "PurchaseError";
  }
}

/** "₹8,000" or "$99.50", from the smallest unit (paise, cents). */
export function formatMoney(amount: number, currency: string) {
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: amount % 100 ? 2 : 0,
  }).format(amount / 100);
}

/** 8000 → 800000, 99.5 → 9950. Refused: zero, negative, or finer than a paisa/cent. */
export function toSubunits(major: number) {
  const subunits = Math.round(major * 100);
  if (!Number.isFinite(major) || subunits < 100 || Math.abs(subunits - major * 100) > 1e-6) {
    throw new PurchaseError("The amount must be at least 1, with at most 2 decimals");
  }
  return subunits;
}

function checkCredits(credits: number) {
  if (!Number.isInteger(credits) || credits < 1) throw new PurchaseError("Credits must be a whole number, 1 or more");
}

function checkCurrency(currency: string): asserts currency is Currency {
  if (!(CURRENCIES as readonly string[]).includes(currency)) throw new PurchaseError(`Currency must be ${CURRENCIES.join(" or ")}`);
}

/**
 * A payment link for `credits` at the agreed price; Razorpay sends it to the payer's email and phone when given.
 * USD (international) needs both: Razorpay refuses the link without them.
 */
export async function createPaymentLinkPurchase(input: {
  org: { id: string; name: string };
  credits: number;
  amount: number;
  currency: string;
  payer?: { email?: string; contact?: string; name?: string };
  note?: string;
}) {
  checkCredits(input.credits);
  checkCurrency(input.currency);
  const amount = toSubunits(input.amount);
  if (input.currency !== "INR" && !(input.payer?.email && input.payer.contact)) {
    throw new PurchaseError(`A ${input.currency} payment link needs the payer's email and phone (Razorpay requires them for international payments)`);
  }
  // The row first, so the link's notes can name it; a link that can't be made leaves no row behind.
  const purchase = await db.creditPurchase.create({
    data: { orgId: input.org.id, credits: input.credits, amount, currency: input.currency, kind: "payment_link", note: input.note ?? null },
  });
  try {
    const link = await createPaymentLink({
      amount,
      currency: input.currency,
      description: `${input.credits.toLocaleString("en-IN")} TrainerTwin credits for ${input.org.name}`,
      referenceId: purchase.id,
      notes: { purchaseId: purchase.id, orgId: input.org.id, credits: String(input.credits) },
      customer: input.payer?.email || input.payer?.contact ? input.payer : undefined,
    });
    return await db.creditPurchase.update({ where: { id: purchase.id }, data: { razorpayId: link.id, url: link.short_url } });
  } catch (error) {
    await db.creditPurchase.delete({ where: { id: purchase.id } }).catch(() => {});
    throw error;
  }
}

/**
 * Links a Razorpay Dashboard invoice (GST) to the org and the credits it buys. An invoice that is already paid adds
 * its credits now; otherwise the webhook does when it's paid.
 */
export async function linkInvoicePurchase(input: { org: { id: string }; invoiceId: string; credits: number; note?: string }) {
  checkCredits(input.credits);
  const invoice = await fetchInvoice(input.invoiceId);
  if (["cancelled", "expired", "deleted"].includes(invoice.status)) throw new PurchaseError(`Invoice ${invoice.id} is ${invoice.status}`);
  checkCurrency(invoice.currency);
  const purchase = await db.creditPurchase.create({
    data: {
      orgId: input.org.id,
      credits: input.credits,
      amount: invoice.amount,
      currency: invoice.currency,
      kind: "invoice",
      razorpayId: invoice.id,
      url: invoice.short_url,
      note: input.note ?? null,
    },
  }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new PurchaseError(`Invoice ${invoice.id} is already linked`, 409);
    throw error;
  });
  if (invoice.status === "paid" && invoice.payment_id) {
    await purchasePaid({ razorpayId: invoice.id, paymentId: invoice.payment_id, amountPaid: invoice.amount_paid, currency: invoice.currency });
    return db.creditPurchase.findUniqueOrThrow({ where: { id: purchase.id } });
  }
  return purchase;
}

/**
 * A payment link or invoice was paid (webhook): adds its credits to the org in Meteroid, once per payment. Not ours
 * (another Razorpay product, or a link made elsewhere): null. A different amount or currency than agreed adds nothing.
 */
export async function purchasePaid(input: { razorpayId: string; purchaseId?: string; paymentId: string; amountPaid: number; currency: string }) {
  const purchase = await db.creditPurchase.findUnique({ where: { razorpayId: input.razorpayId } })
    ?? (input.purchaseId ? await db.creditPurchase.findUnique({ where: { id: input.purchaseId } }) : null);
  if (!purchase) return null;
  if (input.currency !== purchase.currency || input.amountPaid !== purchase.amount) {
    throw new PurchaseError(
      `${purchase.razorpayId ?? purchase.id}: paid ${formatMoney(input.amountPaid, input.currency)}, agreed ${formatMoney(purchase.amount, purchase.currency)}; no credits added`,
      422,
    );
  }
  const billing = await db.orgBilling.findUnique({ where: { orgId: purchase.orgId }, select: { meteroidCustomerId: true } });
  if (!billing) throw new PurchaseError(`${input.razorpayId}: the org isn't billed by Meteroid yet (scripts/meteroid-link-org.ts); no credits added`, 409);
  // Claim the purchase first: a second, different payment for the same one adds nothing. The same payment again (a
  // webhook retry) grants again with the same key, which Meteroid answers with the first grant.
  const claimed = await db.creditPurchase.updateMany({
    where: { id: purchase.id, status: "created" },
    data: { status: "paid", paymentId: input.paymentId, paidAt: new Date(), razorpayId: input.razorpayId },
  });
  // Lost the claim: read who won it (the copy read above may predate a concurrent delivery of this payment).
  const current = await db.creditPurchase.findUnique({ where: { id: purchase.id }, select: { paymentId: true, paidAt: true } });
  if (claimed.count !== 1 && current?.paymentId !== input.paymentId) {
    throw new PurchaseError(`${input.razorpayId} was already paid; payment ${input.paymentId} added nothing`, 409);
  }
  // Meteroid answers a repeated key with the first grant only for an identical request: the expiry comes from the
  // recorded payment time, so a retry sends the same grant.
  const paidAt = current?.paidAt ?? new Date();
  try {
    await grantMinutes({
      customerId: billing.meteroidCustomerId,
      minutes: purchase.credits,
      type: "PAID",
      reason: `Paid ${formatMoney(purchase.amount, purchase.currency)} · Razorpay ${input.razorpayId}`,
      reference: input.paymentId,
      expiresAt: new Date(paidAt.getTime() + PURCHASE_VALID_DAYS * 86_400_000),
      idempotencyKey: `razorpay:${input.paymentId}`,
    });
  } catch (error) {
    // Not granted: unclaim, so Razorpay's retry (or reconciliation) tries again.
    if (claimed.count === 1) await db.creditPurchase.updateMany({ where: { id: purchase.id, paymentId: input.paymentId }, data: { status: "created", paymentId: null, paidAt: null } });
    throw error;
  }
  await scheduleOrgSync(purchase.orgId);
  return { credits: purchase.credits, duplicate: claimed.count !== 1 };
}

/**
 * A payment was refunded (webhook). shortcut: the credits are not taken back from Meteroid yet (refunds are rare and
 * handled by hand); the refund is logged for a person.
 */
export async function purchaseRefunded(input: { refundId: string; paymentId: string; amount: number; currency: string }) {
  const purchase = await db.creditPurchase.findUnique({ where: { paymentId: input.paymentId }, select: { id: true, orgId: true } });
  if (!purchase) return null;
  console.error(`[razorpay] refund ${input.refundId} (${formatMoney(input.amount, input.currency)}) of purchase ${purchase.id}: credits NOT taken back; adjust in Meteroid by hand`);
  return { refundId: input.refundId, creditsTakenBack: 0 };
}

export type ReconcileLine = { purchase: string; razorpayId: string | null; org: string; action: "paid" | "refunded" | "still unpaid" | "error"; detail: string };

/**
 * Webhooks are best effort: a payment whose webhook never arrived leaves its credits unadded. This asks Razorpay
 * directly and applies what's missing through the same purchasePaid the webhook uses (still once). Checks purchases
 * unpaid for more than `olderThanHours` (younger ones may still be mid-checkout). `apply: false` only reports.
 * `refundDays` is ignored while refunds aren't taken back.
 */
export async function reconcilePurchases(input: { olderThanHours: number; refundDays: number; apply: boolean }) {
  const lines: ReconcileLine[] = [];
  const unpaid = await db.creditPurchase.findMany({
    where: { status: "created", razorpayId: { not: null }, createdAt: { lt: new Date(Date.now() - input.olderThanHours * 3_600_000) } },
    select: { id: true, razorpayId: true, kind: true, currency: true, organization: { select: { slug: true } } },
    orderBy: { createdAt: "asc" },
  });
  for (const purchase of unpaid) {
    const line = (action: ReconcileLine["action"], detail: string) =>
      lines.push({ purchase: purchase.id, razorpayId: purchase.razorpayId, org: purchase.organization.slug, action, detail });
    try {
      let paid: { paymentId: string; amountPaid: number; currency: string } | null = null;
      if (purchase.kind === "payment_link") {
        const link = await fetchPaymentLink(purchase.razorpayId!);
        const payment = link.status === "paid" ? (link.payments ?? []).find((p) => p.status === "captured") : undefined;
        if (payment) paid = { paymentId: payment.payment_id, amountPaid: payment.amount, currency: link.currency };
      } else {
        const invoice = await fetchInvoice(purchase.razorpayId!);
        if (invoice.status === "paid" && invoice.payment_id) paid = { paymentId: invoice.payment_id, amountPaid: invoice.amount_paid, currency: invoice.currency };
      }
      if (!paid) {
        line("still unpaid", "not paid at Razorpay");
        continue;
      }
      if (input.apply) await purchasePaid({ razorpayId: purchase.razorpayId!, ...paid });
      line("paid", `${formatMoney(paid.amountPaid, paid.currency)} · ${paid.paymentId}${input.apply ? " · credits added" : " · would add credits"}`);
    } catch (error) {
      line("error", error instanceof Error ? error.message : String(error));
    }
  }

  return lines;
}

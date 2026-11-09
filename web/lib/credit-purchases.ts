import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { refundOrg, topUpOrg } from "@/lib/minutes";
import { createPaymentLink, fetchInvoice, fetchPaymentLink, fetchRefunds } from "@/lib/razorpay";

/**
 * Credits an org buys from TrainerTwin, at its own price (CreditPurchase). Two ways in, both through Razorpay:
 * - a payment link we create (scripts/org-payment-link.ts), in INR or USD;
 * - a GST invoice made in the Razorpay Dashboard (its API can't make GST invoices), linked to the org
 *   (scripts/link-invoice.ts).
 * Razorpay's webhook (app/api/razorpay/webhook) then adds the credits when it's paid, once, and takes the refunded
 * share back when it's refunded.
 */

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
 * A payment link or invoice was paid (webhook): adds its credits to the org, once per payment. Not ours (another
 * Razorpay product, or a link made elsewhere): null. A different amount or currency than agreed adds nothing.
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
  return topUpOrg({
    orgId: purchase.orgId,
    minutes: purchase.credits,
    note: `Paid ${formatMoney(purchase.amount, purchase.currency)} · Razorpay ${input.razorpayId}`,
    externalId: input.paymentId,
    alongside: async (tx) => {
      // Only a purchase not paid yet: a second, different payment for the same one adds nothing (rolled back).
      const marked = await tx.creditPurchase.updateMany({
        where: { id: purchase.id, status: "created" },
        data: { status: "paid", paymentId: input.paymentId, paidAt: new Date(), razorpayId: input.razorpayId },
      });
      if (marked.count !== 1) throw new PurchaseError(`${input.razorpayId} was already paid; payment ${input.paymentId} added nothing`, 409);
    },
  });
}

/**
 * A payment was refunded, wholly or in part (webhook): takes the refunded share of the credits back from the org,
 * once per refund. The org's balance may go below zero when those credits were already given to learners.
 */
export async function purchaseRefunded(input: { refundId: string; paymentId: string; amount: number; currency: string }) {
  const purchase = await db.creditPurchase.findUnique({ where: { paymentId: input.paymentId } });
  if (!purchase) return null;
  if (input.currency !== purchase.currency) throw new PurchaseError(`Refund ${input.refundId} is in ${input.currency}, the purchase in ${purchase.currency}`, 422);
  const refunded = Math.min(purchase.amount, purchase.refundedAmount + input.amount);
  // The share of credits for everything refunded so far, less what earlier refunds already took back.
  // shortcut: computed outside the org lock, so two refunds of one purchase arriving at the same moment could round
  // off by a credit; Razorpay sends a payment's refunds one at a time.
  const credits = Math.round((purchase.credits * refunded) / purchase.amount) - Math.round((purchase.credits * purchase.refundedAmount) / purchase.amount);
  const mark = (tx: Prisma.TransactionClient) => tx.creditPurchase.update({
    where: { id: purchase.id },
    data: { refundedAmount: refunded, status: refunded >= purchase.amount ? "refunded" : "partially_refunded" },
  });
  // shortcut: a refund worth less than one credit isn't recorded (no ledger row to make it happen once).
  if (credits < 1) return { orgBalanceMinutes: null, duplicate: false, credits: 0 };
  const result = await refundOrg({
    orgId: purchase.orgId,
    minutes: credits,
    note: `Refund ${formatMoney(input.amount, input.currency)} · Razorpay ${input.refundId}`,
    externalId: input.refundId,
    alongside: mark,
  });
  return { ...result, credits };
}

export type ReconcileLine = { purchase: string; razorpayId: string | null; org: string; action: "paid" | "refunded" | "still unpaid" | "error"; detail: string };

/**
 * Webhooks are best effort: a payment or refund whose webhook never arrived leaves the ledger behind Razorpay. This
 * asks Razorpay directly and applies what's missing through the same purchasePaid / purchaseRefunded the webhook
 * uses (each still happens once). Checks purchases unpaid for more than `olderThanHours` (younger ones may still be
 * mid-checkout), and the refunds of purchases paid in the last `refundDays`. `apply: false` only reports.
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

  const paidRecently = await db.creditPurchase.findMany({
    where: { status: { in: ["paid", "partially_refunded"] }, paymentId: { not: null }, paidAt: { gt: new Date(Date.now() - input.refundDays * 86_400_000) } },
    select: { id: true, razorpayId: true, paymentId: true, organization: { select: { slug: true } } },
    orderBy: { paidAt: "asc" },
  });
  for (const purchase of paidRecently) {
    const line = (action: ReconcileLine["action"], detail: string) =>
      lines.push({ purchase: purchase.id, razorpayId: purchase.razorpayId, org: purchase.organization.slug, action, detail });
    try {
      const refunds = (await fetchRefunds(purchase.paymentId!)).filter((refund) => refund.status === "processed");
      const known = new Set((await db.minuteLedger.findMany({ where: { externalId: { in: refunds.map((r) => r.id) } }, select: { externalId: true } })).map((r) => r.externalId));
      for (const refund of refunds.filter((r) => !known.has(r.id))) {
        if (input.apply) await purchaseRefunded({ refundId: refund.id, paymentId: refund.payment_id, amount: refund.amount, currency: refund.currency });
        line("refunded", `${formatMoney(refund.amount, refund.currency)} · ${refund.id}${input.apply ? " · credits taken back" : " · would take credits back"}`);
      }
    } catch (error) {
      line("error", error instanceof Error ? error.message : String(error));
    }
  }
  return lines;
}

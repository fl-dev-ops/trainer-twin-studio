import { db } from "@/lib/db";
import { Prisma, type BillingInvoice, type OrgBilling } from "@/lib/generated/prisma/client";
import { sendBillingEmail, type BillingEmailArgs } from "@/lib/email";
import { billingDetailsInput, taxFor, meteroidCustomerPatch, type BillingDetails } from "@/lib/billing/details";
import {
  cancelSubscription,
  createPackInvoice,
  getInvoice,
  getSubscription,
  getInvoiceRaw,
  sellerDetails,
  listInvoices,
  TRIAL_PLAN,
  patchCustomer,
  voidInvoice,
  type MeteroidInvoice,
} from "@/lib/billing/meteroid";
import { formatMoney, MAX_PACKS, PACK_CENTS, PACK_CREDITS, PACK_VALID_DAYS, packPrice } from "@/lib/billing/pricing";
import { billingDocument, receiptNumber, renderInvoice, renderReceipt } from "@/lib/billing/documents";
import { closePaymentLink, ensurePaymentLink, reconcilePaymentLink } from "@/lib/billing/razorpay";
import { orgName } from "@/lib/invite/person-email";
import { studioUrl } from "@/lib/invite/links";
import { MeteroidError } from "@/lib/meteroid";
import { orgOfCustomer } from "@/lib/org-credits";
import { getObjectBytes, orgPrefix, putObject, s3Configured } from "@/lib/s3";
import { ADMIN, orgPeople } from "@/lib/org-people";

/**
 * Billing (specs/billing.md): an org's plan (Trial or Paid), its billing details, the invoices Meteroid issues, minute
 * packs, and pausing an org whose Paid renewal is overdue. Meteroid issues every invoice and is the truth for whether
 * one is paid; this module keeps the app's copy (OrgBilling, BillingInvoice), applies what each invoice event means,
 * and sends the billing emails, each once. The workflows in workflows/invoice-issued.ts and invoice-paid.ts call it;
 * so do the webhook, the daily check and Settings › Billing.
 */

export class BillingError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "BillingError";
  }
}

type Tx = Prisma.TransactionClient;
const DAY_MS = 86_400_000;

/** Meteroid refused or couldn't be reached: nothing changed; the person tries again (rule 26). */
async function viaMeteroid<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    console.error(`[billing] ${what}:`, error instanceof Error ? error.message : error);
    if (error instanceof MeteroidError && error.status >= 400 && error.status < 500 && error.status !== 404 && error.status !== 429) {
      throw new BillingError(`Our billing system refused this (${what}). Nothing was changed; please contact TrainerTwin.`, 502);
    }
    throw new BillingError(`Our billing system couldn't be reached (${what}). Nothing was changed; please try again in a minute.`, 502);
  }
}

/** One billing change at a time per org (upgrade, packs, details): a second click waits for the first. */
function locked<T>(orgId: string, work: (tx: Tx) => Promise<T>) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:${orgId}`}))`;
    return work(tx);
  }, { timeout: 60_000, maxWait: 30_000 });
}

async function billingOf(orgId: string, tx: Tx | typeof db = db) {
  const billing = await tx.orgBilling.findUnique({ where: { orgId } });
  if (!billing) throw new BillingError("Billing isn't set up for this organization yet. Contact TrainerTwin.", 404);
  return billing;
}

export const detailsOf = (billing: Pick<OrgBilling, "billingDetails">) => (billing.billingDetails as BillingDetails | null) ?? null;

// ---------------------------------------------------------------------------------------------------------------
// Dates: an invoice is due on its due date, overdue from 00:00 UTC the next day; the reminder goes the day before.

const dateOnly = (date: Date) => date.toISOString().slice(0, 10);
const utcDay = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
export const overdueFrom = (dueDate: Date | string) => new Date(utcDay(typeof dueDate === "string" ? dueDate : dateOnly(dueDate)).getTime() + DAY_MS);
export const remindAt = (dueDate: Date | string) => new Date(utcDay(typeof dueDate === "string" ? dueDate : dateOnly(dueDate)).getTime() - DAY_MS);
const shortDay = (date: Date) => date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

// ---------------------------------------------------------------------------------------------------------------
// Billing details (rules 6–9)

/** Saves billing details: Meteroid's customer first, then the app's copy. Throws BillingError (400, 404, 502). */
export async function saveBillingDetails(orgId: string, input: unknown) {
  const parsed = billingDetailsInput.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BillingError(`${issue.path.join(".") || "details"}: ${issue.message}`, 400);
  }
  const details = parsed.data;
  return locked(orgId, async (tx) => {
    const billing = await billingOf(orgId, tx);
    await viaMeteroid("saving billing details", () => patchCustomer(billing.meteroidCustomerId, meteroidCustomerPatch(details)));
    await tx.orgBilling.update({ where: { orgId }, data: { billingDetails: details as unknown as Prisma.InputJsonValue } });
    return details;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Minute packs (rules 4, 19). Upgrading is done by staff in Meteroid (rule 10): they create the org's subscription on
// the org's own plan, and its first invoice arrives here like any other.

/** The invoice's payment link for someone waiting on it; a Razorpay failure leaves them the email and bank transfer. */
async function payLinkQuietly(invoiceId: string) {
  return ensurePaymentLink(invoiceId).catch((error: unknown) => {
    console.error(`[billing] payment link for ${invoiceId}:`, error instanceof Error ? error.message : error);
    return null;
  });
}

/** A pack's credits expire PACK_VALID_DAYS after its invoice day (end of that day, UTC): the same on a retry that day. */
function packExpiry(now = new Date()) {
  return new Date(utcDay(dateOnly(now)).getTime() + (PACK_VALID_DAYS + 1) * DAY_MS - 1_000);
}

/**
 * Buys `packs` minute packs for a Paid org that isn't paused: Meteroid issues the pack invoice and adds the credits
 * once it's paid. `requestId` (one per click, from the page) makes a retried click buy once.
 */
export async function buyPacks(orgId: string, packs: number, requestId: string) {
  if (!Number.isInteger(packs) || packs < 1 || packs > MAX_PACKS) throw new BillingError(`Buy 1 to ${MAX_PACKS} packs at a time.`, 400);
  const invoiceId = await locked(orgId, async (tx) => {
    const billing = await billingOf(orgId, tx);
    const details = detailsOf(billing);
    if (!details) throw new BillingError("Add your billing details first: they go on the invoice.", 400);
    if (billing.plan !== "paid") throw new BillingError("Minute packs are available on the Paid plan. Upgrade first.", 409);
    if (billing.pausedAt) throw new BillingError("Your plan is paused: pay the overdue invoice first.", 409);
    const price = packPrice(packs, taxFor(details).lines);
    const { invoiceId } = await viaMeteroid("creating the pack invoice", () => createPackInvoice({
      customerId: billing.meteroidCustomerId, credits: price.credits, unitPrice: price.unitPrice, expiresAt: packExpiry(), key: `pack-${orgId}-${requestId}`,
    }));
    return invoiceId;
  });
  const row = await syncInvoice(invoiceId, orgId).catch((error: unknown) => {
    console.error(`[billing] ${orgId}: reading pack invoice ${invoiceId}:`, error);
    return null;
  });
  return { invoiceId, number: row?.number ?? null, totalCents: row?.totalCents ?? null, payUrl: row ? await payLinkQuietly(invoiceId) : null };
}

// ---------------------------------------------------------------------------------------------------------------
// The app's copy of Meteroid's invoices

/**
 * What an invoice is (rule "Invoice" kinds), kept once known. A subscription other than the Trial one (the Credits
 * plan) is the org's paid plan, whatever its plan, name or price (staff create it in Meteroid, rule 10): its first
 * invoice is the upgrade until the org pays it, later ones renewals.
 */
async function kindOf(invoice: MeteroidInvoice, billing: OrgBilling): Promise<BillingInvoice["kind"]> {
  if (invoice.subscriptionId) {
    let paidSub = invoice.subscriptionId === billing.paidSubscriptionId;
    if (!paidSub && billing.plan === "trial" && !billing.paidSubscriptionId) {
      const sub = await getSubscription(invoice.subscriptionId);
      if (sub.planName !== TRIAL_PLAN && LIVE_SUBSCRIPTION.includes(sub.status)) {
        await db.orgBilling.updateMany({ where: { orgId: billing.orgId, paidSubscriptionId: null }, data: { paidSubscriptionId: sub.id } });
        paidSub = true;
      }
    }
    if (paidSub) return billing.plan === "trial" ? "upgrade" : "renewal";
    return "other";
  }
  return invoice.packCredits > 0 ? "pack" : "other";
}

/** A subscription that still bills (Meteroid statuses); anything else is cancelled, ended or not started. */
const LIVE_SUBSCRIPTION = ["ACTIVE", "PENDING_ACTIVATION", "PENDING_CHARGE"];
const ENDED_SUBSCRIPTION = ["CANCELLED", "COMPLETED", "ABORTED"];

const statusOf = (invoice: MeteroidInvoice): BillingInvoice["status"] =>
  invoice.status === "VOID" || invoice.status === "UNCOLLECTIBLE" ? "void" : invoice.paymentStatus === "PAID" ? "paid" : "unpaid";

/**
 * Keeps the app's copy of one Meteroid invoice: created when first seen (finalized, above $0), then its status,
 * payment and references. A paid or void copy never goes back to unpaid. Returns null for invoices the app ignores.
 */
export async function recordInvoice(invoice: MeteroidInvoice, orgId: string): Promise<BillingInvoice | null> {
  const existing = await db.billingInvoice.findUnique({ where: { id: invoice.id } });
  if (!existing && (invoice.totalCents <= 0 || invoice.status === "DRAFT" || invoice.status === "VOID")) return null;
  const status = existing && existing.status !== "unpaid" && statusOf(invoice) === "unpaid" ? existing.status : statusOf(invoice);
  const data = {
    number: invoice.number,
    status,
    totalCents: invoice.totalCents,
    taxCents: invoice.taxCents,
    currency: invoice.currency,
    subscriptionId: invoice.subscriptionId,
    credits: invoice.packCredits,
    issuedAt: invoice.issuedAt,
    dueDate: utcDay(invoice.dueDate),
    periodStart: invoice.periodStart ? utcDay(invoice.periodStart) : null,
    periodEnd: invoice.periodEnd ? utcDay(invoice.periodEnd) : null,
    paidAt: status === "paid" ? (invoice.paidAt ?? existing?.paidAt ?? new Date()) : null,
    paymentRefs: invoice.paymentRefs,
  };
  if (existing) {
    const updated = await db.billingInvoice.update({ where: { id: invoice.id }, data });
    // Voided in Meteroid without the webhook reaching us (seen by the daily check): close its payment link too.
    if (existing.status === "unpaid" && updated.status === "void") await closePaymentLink(updated);
    return updated;
  }
  const billing = await db.orgBilling.findUniqueOrThrow({ where: { orgId } });
  const kind = await kindOf(invoice, billing);
  return db.billingInvoice.upsert({ where: { id: invoice.id }, create: { id: invoice.id, orgId, kind, ...data }, update: data });
}

/** Reads one invoice from Meteroid into the app's copy, and starts its workflows (once each). `paid`: see startInvoiceWorkflows. */
export async function syncInvoice(invoiceId: string, orgId?: string | null, paid = false) {
  const invoice = await getInvoice(invoiceId);
  const org = orgId ?? (await orgOfCustomer(invoice.customerId));
  if (!org) return null;
  const row = await recordInvoice(invoice, org);
  if (row) await startInvoiceWorkflows(row, paid);
  return row;
}

/** Each workflow runs once per invoice: claimed on the row before it starts, released if it can't start. */
async function claim(invoiceId: string, field: "issuedRunAt" | "paidRunAt") {
  return (await db.billingInvoice.updateMany({ where: { id: invoiceId, [field]: null }, data: { [field]: new Date() } })).count === 1;
}

/**
 * Starts what the invoice needs, once each: invoice-issued for any invoice, invoice-paid once it's paid. `paid`: Meteroid
 * said it was paid (invoice.paid) though its API may not show it for a moment; the workflow waits for that.
 */
export async function startInvoiceWorkflows(row: Pick<BillingInvoice, "id" | "status" | "issuedRunAt" | "paidRunAt">, paid = false) {
  const { start } = await import("workflow/api"); // dynamic: the workflows import this module
  if (row.status !== "void" && !row.issuedRunAt && (await claim(row.id, "issuedRunAt"))) {
    const { invoiceIssued } = await import("@/workflows/invoice-issued");
    await start(invoiceIssued, [row.id]).catch(async (error: unknown) => {
      console.error(`[billing] could not start invoice-issued for ${row.id}:`, error);
      await db.billingInvoice.update({ where: { id: row.id }, data: { issuedRunAt: null } });
    });
  }
  if ((row.status === "paid" || (paid && row.status === "unpaid")) && !row.paidRunAt && (await claim(row.id, "paidRunAt"))) {
    const { invoicePaid: invoicePaidWorkflow } = await import("@/workflows/invoice-paid");
    await start(invoicePaidWorkflow, [row.id]).catch(async (error: unknown) => {
      console.error(`[billing] could not start invoice-paid for ${row.id}:`, error);
      await db.billingInvoice.update({ where: { id: row.id }, data: { paidRunAt: null } });
    });
  }
}

/** Re-reads the invoice from Meteroid (the truth for paid / void) into the copy. */
async function refreshed(invoiceId: string) {
  const row = await db.billingInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
  return (await recordInvoice(await getInvoice(invoiceId), row.orgId)) ?? row;
}

// ---------------------------------------------------------------------------------------------------------------
// Invoice events (the workflows' steps)

/** The invoice's copy for the invoice-issued workflow: kind, status and due date, read fresh from Meteroid. */
export async function invoiceForWorkflow(invoiceId: string) {
  const row = await refreshed(invoiceId);
  return { kind: row.kind, status: row.status, dueDate: dateOnly(row.dueDate) };
}

/** Rule 15: a renewal overdue unpaid pauses the org. Returns whether this call paused it. */
async function pauseFor(row: BillingInvoice) {
  return (await db.orgBilling.updateMany({ where: { orgId: row.orgId, plan: "paid", pausedAt: null, paidSubscriptionId: row.subscriptionId }, data: { pausedAt: new Date() } })).count === 1;
}

/**
 * When an invoice becomes overdue: a renewal of the org's current Paid subscription pauses it; an upgrade is cancelled
 * (invoice voided, subscription cancelled, org stays on Trial). Re-reads Meteroid first: an invoice paid in the
 * meantime changes nothing. Safe to repeat, and resumes where a failed attempt stopped (the daily check runs it too).
 */
export async function invoiceOverdue(invoiceId: string, now = new Date()) {
  let row = await refreshed(invoiceId);
  if (now < overdueFrom(row.dueDate)) return { action: "none" as const, status: row.status };
  // An upgrade we started cancelling (overdueAt set) is finished even though its invoice already reads void.
  const cancelling = row.kind === "upgrade" && row.status === "void" && row.overdueAt !== null;
  if (row.status !== "unpaid" && !cancelling) return { action: "none" as const, status: row.status };

  if (row.kind === "renewal") {
    row = await db.billingInvoice.update({ where: { id: row.id }, data: { overdueAt: row.overdueAt ?? new Date() } });
    await pauseFor(row);
    // Paid while we paused (Meteroid shows payments a moment late): undo it the way a payment does.
    if ((await refreshed(invoiceId)).status === "paid") {
      await invoicePaid(invoiceId, now);
      return { action: "none" as const, status: "paid" };
    }
    // Only the org's current Paid subscription pauses it (an old, cancelled one doesn't): no pause, no email.
    const paused = await db.orgBilling.count({ where: { orgId: row.orgId, pausedAt: { not: null }, paidSubscriptionId: row.subscriptionId } });
    if (!paused) return { action: "none" as const, status: row.status };
    await emailOnce(row, "paused");
    return { action: "paused" as const };
  }

  if (row.kind === "upgrade") {
    row = await db.billingInvoice.update({ where: { id: row.id }, data: { overdueAt: row.overdueAt ?? new Date() } });
    if (row.status === "unpaid") {
      try {
        await voidInvoice(row.id);
      } catch (error) {
        // Paid at the last moment: Meteroid won't void it. Anything else is retried.
        if ((await refreshed(invoiceId)).status === "paid") return { action: "none" as const, status: "paid" };
        throw error;
      }
      row = await db.billingInvoice.update({ where: { id: row.id }, data: { status: "void" } });
    }
    if (row.subscriptionId) await cancelSubscription(row.subscriptionId, "Upgrade invoice not paid by its due date").catch(async (error: unknown) => {
      if (!ENDED_SUBSCRIPTION.includes((await getSubscription(row.subscriptionId!)).status)) throw error;
    });
    await db.orgBilling.updateMany({ where: { orgId: row.orgId, plan: "trial", paidSubscriptionId: row.subscriptionId }, data: { paidSubscriptionId: null } });
    await closePaymentLink(row);
    await emailOnce(row, "upgrade_cancelled");
    return { action: "upgrade_cancelled" as const };
  }
  return { action: "none" as const, status: row.status };
}

/** Rule 14: on the day before a renewal's due date (UTC), if it's still unpaid; never on another day. */
export async function invoiceReminder(invoiceId: string, now = new Date()) {
  const row = await refreshed(invoiceId);
  if (row.kind !== "renewal" || row.status !== "unpaid") return false;
  if (now < remindAt(row.dueDate) || now >= utcDay(dateOnly(row.dueDate))) return false;
  return emailOnce(row, "reminder");
}

/**
 * A paid invoice's effects (rules 11, 17): an upgrade puts the org on Paid; a renewal unpauses it when nothing else
 * is overdue; a pack's credits come from Meteroid (wallet.funded → sync-org-credits). Safe to repeat.
 */
export async function invoicePaid(invoiceId: string, now = new Date()) {
  const row = await refreshed(invoiceId);
  if (row.status !== "paid") return { paid: false as const };
  let outcome: string | null = null;
  if (row.kind === "upgrade") {
    const billing = await db.orgBilling.findUniqueOrThrow({ where: { orgId: row.orgId } });
    // Its subscription, or a still-live one we lost track of; never one that was cancelled (staff, or a lost race).
    const ours = billing.paidSubscriptionId === row.subscriptionId
      || (!billing.paidSubscriptionId && !!row.subscriptionId && LIVE_SUBSCRIPTION.includes((await getSubscription(row.subscriptionId)).status));
    if (ours) {
      await db.orgBilling.update({ where: { orgId: row.orgId }, data: { plan: "paid", paidSubscriptionId: row.subscriptionId } });
      outcome = "Your organization is now on the Paid plan.";
    } else {
      console.error(`[billing] ${row.orgId}: upgrade ${row.number} paid, but its subscription was cancelled: staff to sort out`);
      outcome = "We'll be in touch about your plan.";
    }
  } else if (row.kind === "renewal") {
    // Unpaused when no renewal of the org's current subscription is still overdue (an old subscription's never blocks,
    // and paying an old one never unpauses a current one).
    const { paidSubscriptionId } = await db.orgBilling.findUniqueOrThrow({ where: { orgId: row.orgId }, select: { paidSubscriptionId: true } });
    const stillOverdue = await db.billingInvoice.count({
      where: { orgId: row.orgId, kind: "renewal", status: "unpaid", subscriptionId: paidSubscriptionId, id: { not: row.id }, dueDate: { lt: utcDay(dateOnly(now)) } },
    });
    if (!stillOverdue) await db.orgBilling.updateMany({ where: { orgId: row.orgId, pausedAt: { not: null } }, data: { pausedAt: null } });
    // Said from the org's state now, so a retried step says the same thing.
    const paused = (await db.orgBilling.findUniqueOrThrow({ where: { orgId: row.orgId }, select: { pausedAt: true } })).pausedAt;
    outcome = paused
      ? "Your plan stays paused until the other overdue invoice is paid."
      : "Your plan is active: calls and credits work as normal.";
  } else if (row.kind === "pack") {
    outcome = `${row.credits} credits are being added to your organization (you'll get a separate email when they arrive).`;
  }
  await closePaymentLink(row); // paid by bank transfer: the link mustn't take a second payment (none if Razorpay paid it)
  await emailOnce(row, "paid", outcome);
  return { paid: true as const, kind: row.kind, outcome };
}

/** Rule 24: Meteroid voided the invoice (staff, or an upgrade cancelled): no more reminders or pausing for it. */
export async function invoiceVoided(invoiceId: string) {
  await db.billingInvoice.updateMany({ where: { id: invoiceId, status: "unpaid" }, data: { status: "void" } });
  const row = await db.billingInvoice.findUnique({ where: { id: invoiceId } });
  if (row) await closePaymentLink(row);
}

/** Rule 18: the org's Paid subscription was cancelled or ended in Meteroid: back to Trial, unpaused. */
export async function paidSubscriptionEnded(subscriptionId: string) {
  return (await db.orgBilling.updateMany({ where: { paidSubscriptionId: subscriptionId }, data: { plan: "trial", paidSubscriptionId: null, pausedAt: null } })).count === 1;
}

// ---------------------------------------------------------------------------------------------------------------
// Emails (rule 21): once per invoice and event

const EMAIL_FIELD = { issued: "issuedEmailAt", reminder: "reminderAt", paused: "overdueEmailAt", upgrade_cancelled: "overdueEmailAt", paid: "paidEmailAt" } as const;

/** Where billing emails go: the billing emails, or the org admin when there are none. */
async function recipients(orgId: string) {
  const billing = await db.orgBilling.findUniqueOrThrow({ where: { orgId } });
  const emails = detailsOf(billing)?.emails ?? [];
  if (emails.length) return emails;
  const [admin] = await orgPeople(orgId, { roles: [ADMIN] });
  return admin ? [admin.email] : [];
}

export function describeInvoice(row: Pick<BillingInvoice, "kind" | "credits" | "periodStart" | "periodEnd">) {
  const period = row.periodStart && row.periodEnd ? `, ${shortDay(row.periodStart)} – ${shortDay(new Date(row.periodEnd.getTime() - DAY_MS))}` : "";
  if (row.kind === "upgrade" || row.kind === "renewal") return `TrainerTwin Paid plan${period}`;
  if (row.kind === "pack") return `Minute packs: ${row.credits} credits`;
  return "TrainerTwin";
}

/** The invoice as the PDFs show it, from Meteroid (its numbers, lines, tax and the customer when it was issued). */
async function documentOf(row: Pick<BillingInvoice, "id" | "orgId">) {
  const payments = await db.billingPayment.findMany({ where: { invoiceId: row.id }, select: { id: true, method: true } });
  const [raw, name, seller] = await Promise.all([getInvoiceRaw(row.id), orgName(row.orgId), sellerDetails()]);
  return billingDocument(raw, name, seller, Object.fromEntries(payments.map((p) => [p.id, p.method])));
}

/**
 * A document as first made, kept (rule 22): the first time it's needed it's drawn and saved to S3, and every later
 * email or download sends that same copy, so an issued invoice never changes (not even if the company's details do).
 * Without S3 (local development) it's drawn each time.
 */
async function keptPdf(row: Pick<BillingInvoice, "id" | "orgId" | "number">, field: "invoicePdfKey" | "receiptPdfKey", key: string | null, draw: () => Promise<Buffer>) {
  if (!s3Configured) return draw();
  if (key) return Buffer.from(await getObjectBytes(key));
  // One first copy: the first to get here draws and saves it; anyone at the same moment waits and gets that copy.
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pdf:${field}:${row.id}`}))`;
    const saved = (await tx.billingInvoice.findUniqueOrThrow({ where: { id: row.id }, select: { invoicePdfKey: true, receiptPdfKey: true } }))[field];
    if (saved) return Buffer.from(await getObjectBytes(saved));
    const pdf = await draw();
    const newKey = `${orgPrefix(row.orgId)}/billing/${field === "invoicePdfKey" ? "" : "RCPT-"}${row.number}-${row.id}.pdf`;
    await putObject(newKey, pdf, "application/pdf");
    await tx.billingInvoice.update({ where: { id: row.id }, data: { [field]: newKey } });
    return pdf;
  }, { timeout: 60_000, maxWait: 60_000 });
}

/** The tax invoice PDF (lib/billing/documents.ts), kept as first sent. */
export async function invoicePdf(row: Pick<BillingInvoice, "id" | "orgId" | "number" | "status" | "paymentLinkUrl" | "invoicePdfKey">) {
  return keptPdf(row, "invoicePdfKey", row.invoicePdfKey, async () =>
    renderInvoice(await documentOf(row), row.status === "unpaid" ? row.paymentLinkUrl : null, row.status === "unpaid"));
}

/** The receipt PDF of a paid invoice, kept as first sent. */
export async function receiptPdf(row: BillingInvoice) {
  return keptPdf(row, "receiptPdfKey", row.receiptPdfKey, async () => renderReceipt(await documentOf(row), row.paidAt ?? row.updatedAt));
}

/**
 * Sends one billing email for the invoice, once: the app's record of it is checked first (a retry days later doesn't
 * send it again), and Resend's key covers a retry while it's being sent. Returns whether it was sent now.
 */
async function emailOnce(row: BillingInvoice, event: BillingEmailArgs["event"], outcome: string | null = null) {
  const field = EMAIL_FIELD[event];
  if (row[field]) return false;
  const to = await recipients(row.orgId);
  if (!to.length) {
    console.error(`[billing] ${row.orgId}: no one to email about ${row.number} (${event})`);
    return false;
  }
  const attachments: { filename: string; content: Buffer }[] = [];
  if (event !== "upgrade_cancelled") attachments.push({ filename: `${row.number}.pdf`, content: await invoicePdf(row) });
  if (event === "paid") attachments.unshift({ filename: `${receiptNumber(row.number)}.pdf`, content: await receiptPdf(row) });
  const result = await sendBillingEmail({
    to,
    attachments,
    idempotencyKey: `billing-${event}-${row.id}`,
    args: {
      event,
      orgName: await orgName(row.orgId),
      invoiceNumber: row.number,
      amount: formatMoney(row.totalCents, row.currency),
      dueDate: shortDay(row.dueDate),
      description: describeInvoice(row),
      billingUrl: `${studioUrl()}settings?tab=billing`,
      payUrl: row.status === "unpaid" ? row.paymentLinkUrl : null,
      outcome,
    },
  });
  if (!result.success && result.error !== "RESEND_API_KEY is not set") throw new Error(`Billing email ${event} for ${row.number}: ${result.error}`);
  await db.billingInvoice.update({ where: { id: row.id }, data: { [field]: new Date() } });
  return true;
}

/** The invoice-issued workflow's email step. */
export async function invoiceIssuedEmail(invoiceId: string) {
  const row = await db.billingInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
  if (row.status === "void") return false;
  return emailOnce(row, "issued");
}

// ---------------------------------------------------------------------------------------------------------------
// Keeping in step with Meteroid (rule 25)

/** A workflow claimed this long ago that still hasn't sent its email has died (it takes seconds). */
const WORKFLOW_GRACE_MS = 10 * 60_000;

/** Reads the org's recent Meteroid invoices into the app's copy, starts what's missing, and repairs overdue ones. */
export async function syncOrgInvoices(orgId: string, now = new Date()) {
  const billing = await db.orgBilling.findUnique({ where: { orgId } });
  if (!billing) return { invoices: 0, repaired: 0 };
  let invoices = 0;
  let repaired = 0;
  for (const invoice of await listInvoices(billing.meteroidCustomerId)) {
    const row = await recordInvoice(invoice, orgId);
    if (!row) continue;
    invoices++;
    await startInvoiceWorkflows(row);
    // A workflow that was started but died (or a deploy that lost it) left its email or payment unhandled: do it here.
    // Both are safe to run beside a live workflow (each email once, effects idempotent).
    const current = await db.billingInvoice.findUniqueOrThrow({ where: { id: row.id } });
    const dead = (claimedAt: Date | null) => !!claimedAt && claimedAt.getTime() < Date.now() - WORKFLOW_GRACE_MS;
    try {
      if (current.status === "paid" && dead(current.paidRunAt) && !current.paidEmailAt && (await invoicePaid(current.id)).paid) repaired++;
      else if (current.status !== "void" && dead(current.issuedRunAt) && !current.issuedEmailAt && (await invoiceIssuedEmail(current.id))) repaired++;
    } catch (error) {
      console.error(`[billing] ${orgId}: repairing ${row.number}:`, error instanceof Error ? error.message : error);
    }
  }
  // Rule 33: unpaid invoices whose Razorpay payment a lost webhook never brought, and links not made yet.
  for (const row of await db.billingInvoice.findMany({ where: { orgId, status: "unpaid" } })) {
    try {
      if (row.paymentLinkId) {
        if ((await reconcilePaymentLink(row))?.status === "applied") repaired++;
      } else if (await ensurePaymentLink(row.id)) repaired++;
    } catch (error) {
      console.error(`[billing] ${orgId}: Razorpay for ${row.number}:`, error instanceof Error ? error.message : error);
    }
  }
  // Overdue invoices no workflow finished: renewals not paused (or their email not sent), upgrades not cancelled.
  const today = utcDay(dateOnly(now));
  const overdue = await db.billingInvoice.findMany({
    where: {
      orgId, kind: { in: ["renewal", "upgrade"] }, overdueEmailAt: null, dueDate: { lt: today },
      OR: [{ status: "unpaid" }, { kind: "upgrade", status: "void", overdueAt: { not: null } }],
    },
  });
  for (const row of overdue) {
    try {
      if ((await invoiceOverdue(row.id, now)).action !== "none") repaired++;
    } catch (error) {
      console.error(`[billing] ${orgId}: overdue ${row.number}:`, error instanceof Error ? error.message : error);
    }
  }
  // Paused with nothing overdue (paid in a race, or the overdue invoice voided): unpause.
  const current = await db.orgBilling.findUniqueOrThrow({ where: { orgId } });
  if (current.pausedAt) {
    const owing = await db.billingInvoice.count({ where: { orgId, kind: "renewal", status: "unpaid", subscriptionId: current.paidSubscriptionId, dueDate: { lt: today } } });
    if (!owing && (await db.orgBilling.updateMany({ where: { orgId, pausedAt: { not: null } }, data: { pausedAt: null } })).count) repaired++;
  }
  // The Paid subscription cancelled or ended in Meteroid without its webhook reaching us (rule 18).
  if (current.paidSubscriptionId && ENDED_SUBSCRIPTION.includes((await getSubscription(current.paidSubscriptionId)).status)) {
    if (await paidSubscriptionEnded(current.paidSubscriptionId)) repaired++;
  }
  return { invoices, repaired };
}

/** The daily check: every billed org. One org failing doesn't stop the others. */
export async function checkAllBilling(now = new Date()) {
  const orgs = await db.orgBilling.findMany({ select: { orgId: true } });
  const results: { orgId: string; invoices?: number; repaired?: number; error?: string }[] = [];
  for (const { orgId } of orgs) {
    try {
      results.push({ orgId, ...(await syncOrgInvoices(orgId, now)) });
    } catch (error) {
      console.error(`[billing] daily check ${orgId}:`, error);
      results.push({ orgId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------------------------------------------
// Settings › Billing

export type BillingInvoiceView = {
  id: string;
  number: string;
  kind: BillingInvoice["kind"];
  description: string;
  status: "unpaid" | "paid" | "void" | "overdue";
  totalCents: number;
  currency: string;
  subscriptionId: string | null;
  /** Razorpay's payment page while it's unpaid (rule 28). */
  payUrl: string | null;
  issuedAt: string;
  dueDate: string;
  paidAt: string | null;
};

export async function billingOverview(orgId: string, now = new Date()) {
  const billing = await db.orgBilling.findUnique({ where: { orgId }, include: { invoices: { orderBy: { issuedAt: "desc" }, take: 100 } } });
  if (!billing) return { billed: false as const };
  const invoices: BillingInvoiceView[] = billing.invoices.map((row) => ({
    id: row.id,
    number: row.number,
    kind: row.kind as BillingInvoice["kind"],
    description: describeInvoice(row),
    status: row.status === "unpaid" && now >= overdueFrom(row.dueDate) ? "overdue" : (row.status as BillingInvoiceView["status"]),
    totalCents: row.totalCents,
    currency: row.currency,
    subscriptionId: row.subscriptionId,
    payUrl: row.status === "unpaid" ? row.paymentLinkUrl : null,
    issuedAt: row.issuedAt.toISOString(),
    dueDate: dateOnly(row.dueDate),
    paidAt: row.paidAt?.toISOString() ?? null,
  }));
  const upgrade = billing.plan === "trial" && billing.paidSubscriptionId
    ? invoices.find((invoice) => invoice.kind === "upgrade" && invoice.status !== "void" && invoice.status !== "paid") ?? null
    : null;
  const current = (invoice: BillingInvoiceView) => invoice.subscriptionId === billing.paidSubscriptionId;
  const overdue = invoices.find((invoice) => invoice.kind === "renewal" && invoice.status === "overdue" && current(invoice)) ?? null;
  const dueSoon = invoices.find((invoice) => invoice.kind === "renewal" && invoice.status === "unpaid" && current(invoice)) ?? null;
  // The Paid plan renews when its latest period ends (the day after the last day it covers).
  const periods = billing.invoices.filter((row) => row.subscriptionId === billing.paidSubscriptionId && row.status !== "void" && row.periodEnd);
  const renewsOn = billing.plan === "paid" && periods.length ? dateOnly(new Date(Math.max(...periods.map((row) => row.periodEnd!.getTime())))) : null;
  const details = detailsOf(billing);
  return {
    billed: true as const,
    plan: billing.plan as "trial" | "paid",
    upgradePending: billing.plan === "trial" && !!billing.paidSubscriptionId,
    upgradeInvoice: upgrade,
    pausedAt: billing.pausedAt?.toISOString() ?? null,
    overdueInvoice: overdue,
    dueInvoice: dueSoon,
    // The paid plan's price, as Meteroid last invoiced it (tax included); the plan itself lives in Meteroid.
    planCents: billing.invoices.find((row) => row.subscriptionId === billing.paidSubscriptionId && row.status !== "void" && (row.kind === "upgrade" || row.kind === "renewal"))?.totalCents ?? null,
    renewsOn,
    details,
    tax: details ? taxFor(details).kind : null,
    pack: { credits: PACK_CREDITS, cents: PACK_CENTS, maxPacks: MAX_PACKS },
    invoices,
  };
}

/** One invoice of the org, for a download (its PDF, or the receipt once paid). */
export async function orgInvoice(orgId: string, invoiceId: string) {
  const row = await db.billingInvoice.findFirst({ where: { id: invoiceId, orgId } });
  if (!row) throw new BillingError("Invoice not found", 404);
  return row;
}

export async function invoicePdfFor(orgId: string, invoiceId: string) {
  const row = await orgInvoice(orgId, invoiceId);
  return viaMeteroid("reading the invoice", () => invoicePdf(row));
}

export async function receiptPdfFor(orgId: string, invoiceId: string) {
  const row = await orgInvoice(orgId, invoiceId);
  if (row.status !== "paid") throw new BillingError("This invoice isn't paid yet.", 409);
  return viaMeteroid("reading the invoice", () => receiptPdf(row));
}

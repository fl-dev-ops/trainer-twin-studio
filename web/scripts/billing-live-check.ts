/**
 * Billing phase 2 against a real Meteroid tenant (dev or sandbox; never production): runs the whole lifecycle of
 * specs/billing.md with throwaway orgs in the local test database, and checks each step. Workflows aren't running, so
 * their steps are called directly; emails are skipped (no RESEND_API_KEY) but the PDFs they'd attach are fetched.
 * Cleans up after itself (cancels subscriptions, archives customers, deletes the orgs).
 *
 *   METEROID_API_KEY=<dev or sandbox key> bun scripts/billing-live-check.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testDatabaseUrl } from "../tests/setup/test-db-url";

const url = testDatabaseUrl();
if (!url) throw new Error("Needs a local DATABASE_URL to derive the test database from");
process.env.DATABASE_URL = url;
process.env.DATABASE_URL_UNPOOLED = url;
delete process.env.RESEND_API_KEY;
// Workflows don't run in a script: starting one fails and is logged; this script calls their steps itself.
const quiet = console.error;
console.error = (...args: unknown[]) => { if (!String(args[0]).includes("could not start invoice-")) quiet(...args); };
if ((process.env.METEROID_API_KEY ?? "").startsWith("pv_prod") || process.env.METEROID_API_URL?.includes("prod")) throw new Error("Never against production");

const { db } = await import("@/lib/db");
const billing = await import("@/lib/billing/billing");
const { getInvoice, markInvoicePaid, getSubscription } = await import("@/lib/billing/meteroid");
const { linkOrgToMeteroid, unlinkOrgFromMeteroid } = await import("@/lib/org-billing-setup");
const { meteroid, minuteGrants } = await import("@/lib/meteroid");
const { pausedReason } = await import("@/lib/billing/paused");

const tag = Date.now().toString(36);
const created: { orgId: string; customerId: string }[] = [];
const results: string[] = [];
const ok = (what: string) => { results.push(`ok  ${what}`); console.log(`ok  ${what}`); };
const DAY = 86_400_000;

async function newOrg(name: string) {
  const id = `zz-live-${name}-${tag}`;
  await db.organization.create({ data: { id, name: `ZZ live ${name}`, slug: id, createdAt: new Date() } });
  const { customerId } = await linkOrgToMeteroid({ id, slug: id, name: `ZZ live ${name}` });
  created.push({ orgId: id, customerId });
  return id;
}

const details = (country: string, state?: string, taxId?: string) => ({
  legalName: `ZZ Live ${country}${state ?? ""} Pvt Ltd`, country, line1: "1 Test Street", city: country === "IN" ? "Chennai" : "Dubai",
  postalCode: "600001", state, taxId, emails: ["devops+billing-live@foreverlearning.in"],
});

async function payInMeteroid(invoiceId: string, reference: string) {
  const invoice = await getInvoice(invoiceId);
  await markInvoicePaid(invoiceId, (invoice.totalCents / 100).toFixed(2), reference);
  for (let i = 0; i < 20 && (await getInvoice(invoiceId)).paymentStatus !== "PAID"; i++) await new Promise((r) => setTimeout(r, 1_000));
}

try {
  // 1. Tamil Nadu org: details → upgrade → not paid → cancelled → upgrade again → paid → packs → paid.
  const tn = await newOrg("tn");
  await assert.rejects(billing.requestUpgrade(tn), /billing details first/);
  await assert.rejects(billing.saveBillingDetails(tn, details("IN", "29", "33AAGCF6592D1ZN")), /registered in Tamil Nadu/);
  await billing.saveBillingDetails(tn, details("IN", "33", "33AAGCF6592D1ZN"));
  const customer = await meteroid<{ custom_taxes: { tax_code: string }[]; billing_address: { line2: string } }>("GET", `/customers/${created[0].customerId}`);
  assert.deepEqual(customer.custom_taxes.map((t) => t.tax_code), ["CGST", "SGST"]);
  assert.match(customer.billing_address.line2, /Tamil Nadu \(33\)/);
  ok("details saved: CGST + SGST on the Meteroid customer, state on line 2");

  await assert.rejects(billing.buyPacks(tn, 1, randomUUID()), /Paid plan/);
  ok("Trial org can't buy packs");

  const first = await billing.requestUpgrade(tn);
  assert.equal((await billing.requestUpgrade(tn)).subscriptionId, first.subscriptionId);
  let rows = await db.billingInvoice.findMany({ where: { orgId: tn } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "upgrade");
  assert.equal(rows[0].totalCents, 30_000);
  assert.equal(rows[0].taxCents, 4_576);
  const dueDays = Math.round((rows[0].dueDate.getTime() - new Date(new Date().toISOString().slice(0, 10)).getTime()) / DAY);
  assert.equal(dueDays, 2);
  assert.equal((await db.orgBilling.findUniqueOrThrow({ where: { orgId: tn } })).plan, "trial");
  ok(`upgrade: invoice ${rows[0].number} $300.00 incl. $45.76 GST, due in 2 days, org still Trial; asking again returns the same`);

  assert.equal(await billing.invoiceIssuedEmail(rows[0].id), true);
  assert.equal(await billing.invoiceIssuedEmail(rows[0].id), false);
  ok("issued email: once (invoice PDF fetched from Meteroid)");

  assert.equal((await billing.invoiceOverdue(rows[0].id)).action, "none");
  const later = new Date(rows[0].dueDate.getTime() + DAY + 60_000);
  assert.equal((await billing.invoiceOverdue(rows[0].id, later)).action, "upgrade_cancelled");
  assert.equal((await getInvoice(rows[0].id)).status, "VOID");
  let status = (await getSubscription(first.subscriptionId)).status;
  for (let i = 0; i < 15 && status !== "CANCELLED"; i++) {
    await new Promise((r) => setTimeout(r, 1_000)); // Meteroid applies a cancellation a moment later
    status = (await getSubscription(first.subscriptionId)).status;
  }
  assert.equal(status, "CANCELLED");
  const afterCancel = await db.orgBilling.findUniqueOrThrow({ where: { orgId: tn } });
  assert.equal(afterCancel.plan, "trial");
  assert.equal(afterCancel.paidSubscriptionId, null);
  ok("upgrade unpaid past due: invoice voided, subscription cancelled, org on Trial");

  const second = await billing.requestUpgrade(tn);
  assert.notEqual(second.subscriptionId, first.subscriptionId);
  rows = await db.billingInvoice.findMany({ where: { orgId: tn, status: "unpaid" } });
  assert.equal(rows.length, 1);
  await payInMeteroid(rows[0].id, `live-bank-${tag}-1`);
  const paid = await billing.invoicePaid(rows[0].id);
  assert.equal(paid.paid && paid.kind, "upgrade");
  const afterPay = await db.orgBilling.findUniqueOrThrow({ where: { orgId: tn } });
  assert.equal(afterPay.plan, "paid");
  assert.equal(afterPay.paidSubscriptionId, second.subscriptionId);
  const paidRow = await db.billingInvoice.findUniqueOrThrow({ where: { id: rows[0].id } });
  assert.deepEqual(paidRow.paymentRefs, [`live-bank-${tag}-1`]);
  assert.ok(paidRow.paidEmailAt);
  const receipt = await billing.receiptPdfFor(tn, rows[0].id);
  assert.equal(receipt.subarray(0, 5).toString(), "%PDF-");
  ok("upgrade again the same day: new subscription; paid → Paid plan, receipt rendered, paid email marked");

  await assert.rejects(billing.requestUpgrade(tn), /already on the Paid plan/);
  const pack = await billing.buyPacks(tn, 2, randomUUID());
  const packRow = await db.billingInvoice.findUniqueOrThrow({ where: { id: pack.invoiceId } });
  assert.equal(packRow.kind, "pack");
  assert.equal(packRow.credits, 200);
  assert.equal(packRow.totalCents, 5_000);
  const packInvoice = await getInvoice(pack.invoiceId);
  assert.equal(packInvoice.totalCents, 5_000);
  ok(`2 packs: invoice ${packRow.number} exactly $50.00 (net ${(packInvoice.totalCents - packInvoice.taxCents) / 100} + GST ${packInvoice.taxCents / 100})`);
  const before = (await minuteGrants(created[0].customerId)).filter((g) => g.reason?.includes("paid invoice")).length;
  await payInMeteroid(pack.invoiceId, `live-bank-${tag}-2`);
  await billing.invoicePaid(pack.invoiceId);
  let grants = await minuteGrants(created[0].customerId);
  for (let i = 0; i < 15 && grants.filter((g) => g.reason?.includes("paid invoice")).length === before; i++) {
    await new Promise((r) => setTimeout(r, 2_000));
    grants = await minuteGrants(created[0].customerId);
  }
  const packGrant = grants.find((g) => g.minutes === 200);
  assert.ok(packGrant, "a 200-credit grant after the pack was paid");
  const expiresInDays = (new Date(packGrant.expiresAt!).getTime() - Date.now()) / DAY;
  assert.ok(expiresInDays > 364 && expiresInDays < 367, `pack credits expire in ~365 days (got ${expiresInDays.toFixed(1)})`);
  ok("pack paid: Meteroid granted 200 credits expiring in a year");

  // 2. Pause and unpause. A renewal can't be made to happen now, so a second real Paid subscription stands in for the
  //    org's current one: its first invoice is a real subscription invoice, read as the renewal of a Paid org.
  const { createPaidSubscription } = await import("@/lib/billing/meteroid");
  const stand = await createPaidSubscription({ orgId: tn, customerId: created[0].customerId, today: new Date().toISOString().slice(0, 10), attempt: 99 });
  await db.orgBilling.update({ where: { orgId: tn }, data: { paidSubscriptionId: stand.id } });
  let renewalId: string | undefined;
  for (let i = 0; i < 15 && !renewalId; i++) {
    await billing.syncOrgInvoices(tn);
    renewalId = (await db.billingInvoice.findFirst({ where: { orgId: tn, subscriptionId: stand.id } }))?.id;
    if (!renewalId) await new Promise((r) => setTimeout(r, 1_000));
  }
  assert.ok(renewalId, "the stand-in renewal invoice");
  const renewalRow = await db.billingInvoice.findUniqueOrThrow({ where: { id: renewalId } });
  assert.equal(renewalRow.kind, "renewal");
  const reminderDay = new Date(renewalRow.dueDate.getTime() - DAY + 60_000);
  assert.equal(await billing.invoiceReminder(renewalId), false, "no reminder on the invoice day");
  assert.equal(await billing.invoiceReminder(renewalId, reminderDay), true);
  assert.equal(await billing.invoiceReminder(renewalId, reminderDay), false);
  assert.equal((await billing.invoiceOverdue(renewalId, new Date(renewalRow.dueDate.getTime() + DAY + 1))).action, "paused");
  assert.ok((await db.orgBilling.findUniqueOrThrow({ where: { orgId: tn } })).pausedAt);
  assert.match((await pausedReason(tn, "studio")) ?? "", /paused/);
  await assert.rejects(billing.buyPacks(tn, 1, randomUUID()), /paused/);
  ok(`renewal ${renewalRow.number}: reminder once; overdue → paused (calls and credits refused, packs refused)`);
  await payInMeteroid(renewalId, `live-bank-${tag}-3`);
  const unpaused = await billing.invoicePaid(renewalId);
  assert.match(unpaused.paid ? unpaused.outcome ?? "" : "", /plan is active/);
  assert.equal((await db.orgBilling.findUniqueOrThrow({ where: { orgId: tn } })).pausedAt, null);
  ok("renewal paid: unpaused");

  // An overdue invoice of a subscription that isn't the org's current one never pauses it.
  await db.billingInvoice.update({ where: { id: renewalId }, data: { status: "unpaid", overdueAt: null } });
  await db.orgBilling.update({ where: { orgId: tn }, data: { paidSubscriptionId: second.subscriptionId } });

  // 3. Another Indian state (IGST) and abroad (export): a pack's tax and total.
  for (const [name, d, taxCents] of [["ka", details("IN", "29"), 381], ["ae", details("AE", undefined, "100000000000003"), 0]] as const) {
    const org = await newOrg(name);
    await billing.saveBillingDetails(org, d);
    await db.orgBilling.update({ where: { orgId: org }, data: { plan: "paid" } });
    const bought = await billing.buyPacks(org, 1, randomUUID());
    const invoice = await getInvoice(bought.invoiceId);
    assert.equal(invoice.totalCents, 2_500);
    assert.equal(invoice.taxCents, taxCents);
    ok(`${name === "ka" ? "Karnataka: IGST 18%" : "UAE: export, no GST"} → pack invoice $25.00, tax $${(taxCents / 100).toFixed(2)}`);
  }

  // 4. The daily check finds nothing to repair.
  const check = await billing.syncOrgInvoices(tn);
  assert.equal(check.repaired, 0);
  ok(`daily check: ${check.invoices} invoices read, nothing to repair`);
  console.log(`\nALL OK (${results.length} checks)`);
} finally {
  for (const { orgId, customerId } of created) {
    await unlinkOrgFromMeteroid(customerId).catch((error: unknown) => console.error(`cleanup ${customerId}:`, error instanceof Error ? error.message : error));
    await db.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  }
  await db.$disconnect();
}

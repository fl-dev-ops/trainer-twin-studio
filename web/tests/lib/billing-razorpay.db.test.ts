import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Papa from "papaparse";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";
import { fundOrg } from "../setup/meteroid";

const previousEnabled = process.env.RAZORPAY_ENABLED;
process.env.RAZORPAY_ENABLED = "true"; // check-billing captures the switch when it builds the SQL.
const { BILLING_CHECKS } = await import("../../scripts/check-billing");
if (previousEnabled === undefined) delete process.env.RAZORPAY_ENABLED; else process.env.RAZORPAY_ENABLED = previousEnabled;

describe.skipIf(!localMinutesDb)("billing Razorpay schema, invariants and accountant CSV (local DB)", () => {
  let f: MinutesFixture;
  const invoiceData = (suffix = "one") => ({ id: `invoice-${f.org.id}-${suffix}`, orgId: f.org.id, number: `INV-${suffix}`, kind: "other", status: "unpaid", totalCents: 30000, currency: "USD", issuedAt: new Date("2026-11-11"), dueDate: new Date("2099-11-13"), issuedEmailAt: new Date() });
  const paymentData = (suffix = "one") => ({ id: `pay_${f.org.id}_${suffix}`, invoiceId: invoiceData().id, orgId: f.org.id, paymentLinkId: `plink_${f.org.id}`, status: "applied", amount: 30000, currency: "USD", paidAt: new Date("2026-11-12T10:00:00Z") });
  const broken = async (check: typeof BILLING_CHECKS[number]) => (await db.$queryRawUnsafe<{ n: number }[]>(`${check.sql} and i."orgId" = $1`, f.org.id))[0].n;
  const appliedCheck = BILLING_CHECKS.find((c) => c.rule.includes("Razorpay payment settled"))!;
  const linkCheck = BILLING_CHECKS.find((c) => c.rule.includes("whose org has a phone"))!;
  async function report(month: string, fixtures: Record<string, unknown> = {}) {
    // Preload only fakes Razorpay; the script's real top-level query runs against the same test DB as this suite.
    const child = Bun.spawn([process.execPath, "--preload", "./tests/setup/billing-razorpay-script-preload.ts", "scripts/billing-fee-report.ts", "--month", month], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL!, RAZORPAY_ENABLED: "true", RAZORPAY_KEY_ID: "rzp_test_report", RAZORPAY_KEY_SECRET: "test-secret", BILLING_REPORT_RAZORPAY_FIXTURES: JSON.stringify(fixtures) }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode, rows: Papa.parse<Record<string, string>>(stdout.trim(), { header: true }).data };
  }
  beforeEach(async () => { f = minutesFixture(); await f.create(); await fundOrg({ orgId: f.org.id, minutes: 0 }); });
  afterEach(async () => { await f.clean(); });

  test("schema: link/payment ids unique; many invoices may retain null links/payment ids", async () => {
    await db.billingInvoice.create({ data: { ...invoiceData(), paymentLinkId: "plink_unique", razorpayPaymentId: "pay_unique" } });
    await expect(Promise.resolve(db.billingInvoice.create({ data: { ...invoiceData("two"), paymentLinkId: "plink_unique" } }))).rejects.toMatchObject({ code: "P2002" });
    await expect(Promise.resolve(db.billingInvoice.create({ data: { ...invoiceData("two"), razorpayPaymentId: "pay_unique" } }))).rejects.toMatchObject({ code: "P2002" });
    await db.billingInvoice.createMany({ data: [invoiceData("two"), invoiceData("three")] }); expect(await db.billingInvoice.count({ where: { orgId: f.org.id } })).toBe(3);
  });
  test("schema: BillingPayment id deduplicates; applied/duplicate allowed, other statuses and nonpositive amounts rejected", async () => {
    await db.billingInvoice.create({ data: invoiceData() }); await db.billingPayment.create({ data: paymentData() });
    await expect(Promise.resolve(db.billingPayment.create({ data: paymentData() }))).rejects.toMatchObject({ code: "P2002" });
    await db.billingPayment.create({ data: { ...paymentData("duplicate"), status: "duplicate" } });
    for (const data of [{ ...paymentData("bad-status"), status: "pending" }, { ...paymentData("zero"), amount: 0 }, { ...paymentData("negative"), amount: -1 }]) await expect(Promise.resolve(db.billingPayment.create({ data }))).rejects.toThrow();
    await expect(Promise.resolve(db.billingPayment.create({ data: { ...paymentData("missing-invoice"), invoiceId: "missing" } }))).rejects.toThrow();
    await db.billingInvoice.delete({ where: { id: invoiceData().id } }); expect(await db.billingPayment.count({ where: { orgId: f.org.id } })).toBe(0);
  });
  test("new Check: an old Razorpay-settled invoice needs an applied payment record and paid status", async () => {
    const old = new Date(Date.now() - 2 * 3600000);
    await db.billingInvoice.create({ data: { ...invoiceData(), razorpayPaymentId: paymentData().id, updatedAt: old } });
    expect(await broken(appliedCheck)).toBe(1);
    await db.billingPayment.create({ data: { ...paymentData(), status: "duplicate" } }); expect(await broken(appliedCheck)).toBe(1);
    await db.billingPayment.update({ where: { id: paymentData().id }, data: { status: "applied" } }); expect(await broken(appliedCheck)).toBe(1);
    await db.billingInvoice.update({ where: { id: invoiceData().id }, data: { status: "paid", paidAt: new Date(), updatedAt: old } }); expect(await broken(appliedCheck)).toBe(0);
  });
  test("new Check: old phone-bearing unpaid invoices need a link; legacy phone-less details and void invoices exempt", async () => {
    await db.billingInvoice.create({ data: { ...invoiceData(), createdAt: new Date(Date.now() - 2 * 3600000) } });
    expect(await broken(linkCheck)).toBe(0);
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { billingDetails: { phone: "+19876543210" } } }); expect(await broken(linkCheck)).toBe(1);
    await db.billingInvoice.update({ where: { id: invoiceData().id }, data: { paymentLinkId: "plink_check" } }); expect(await broken(linkCheck)).toBe(0);
    await db.billingInvoice.update({ where: { id: invoiceData().id }, data: { paymentLinkId: null, status: "void" } }); expect(await broken(linkCheck)).toBe(0);
  });
  test("new Check: Razorpay disabled exempts old unpaid phone-bearing invoices in the real check-billing script", async () => {
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { billingDetails: { phone: "+19876543210" } } });
    await db.billingInvoice.create({ data: { ...invoiceData(), createdAt: new Date(Date.now() - 2 * 3600000) } });
    expect(await broken(linkCheck)).toBe(1);
    const child = Bun.spawn([process.execPath, "scripts/check-billing.ts"], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL!, RAZORPAY_ENABLED: "false" }, stdout: "pipe", stderr: "pipe" });
    const [stdout] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stdout.split("\n").find((line) => line.includes("whose org has a phone"))).toBe(`ok   ${linkCheck.rule}`);
  });
  test("Checks: fresh unpaid invoice gets the one-hour grace even with a non-UTC PostgreSQL session", async () => {
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { billingDetails: { phone: "+19876543210" } } });
    await db.billingInvoice.create({ data: { ...invoiceData(), createdAt: new Date() } });
    // Reproduce the deployment's timezone explicitly, independent of the test machine's timezone.
    const count = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Asia/Kolkata'");
      return (await tx.$queryRawUnsafe<{ n: number }[]>(`${linkCheck.sql} and i.\"orgId\" = $1`, f.org.id))[0].n;
    });
    expect(count).toBe(0);
  });
  test("Checks: just-applied payment gets Meteroid's one-hour lag grace in a non-UTC PostgreSQL session", async () => {
    await db.billingInvoice.create({ data: { ...invoiceData(), razorpayPaymentId: paymentData().id, updatedAt: new Date() } });
    await db.billingPayment.create({ data: paymentData() });
    const count = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Asia/Kolkata'");
      return (await tx.$queryRawUnsafe<{ n: number }[]>(`${appliedCheck.sql} and i.\"orgId\" = $1`, f.org.id))[0].n;
    });
    expect(count).toBe(0);
  });
  test("rule 34: real fee-report CSV columns, duplicates, missing fee backfill, INR net, next-month settlement and UTC month boundaries", async () => {
    await db.billingInvoice.create({ data: { ...invoiceData(), number: 'INV-"November",1' } });
    const paymentId = paymentData().id;
    await db.billingPayment.create({ data: paymentData() });
    for (const [suffix, paidAt, status] of [["before", "2026-10-31T23:59:59.999Z", "applied"], ["start", "2026-11-01T00:00:00Z", "duplicate"], ["end", "2026-11-30T23:59:59.999Z", "applied"], ["after", "2026-12-01T00:00:00Z", "applied"]] as const) await db.billingPayment.create({ data: { ...paymentData(suffix), status, paidAt: new Date(paidAt), amountInr: 2500000, feeInr: 88500, taxInr: 13500, method: "card", international: true } });
    const result = await report("2026-11", {
      [`/v1/payments/${paymentId}`]: { id: paymentId, base_amount: 2500000, fee: 88500, tax: 13500, method: "card", international: true },
      "/v1/settlements/recon/combined?year=2026&month=11&skip=0&count=1000": { items: [] },
      "/v1/settlements/recon/combined?year=2026&month=12&skip=0&count=1000": { items: [{ entity_id: paymentId, type: "payment", settled: true, settlement_id: "setl_1", settled_at: Date.parse("2026-12-02T10:00:00Z") / 1000 }] },
    });
    expect(result.exitCode).toBe(0);
    expect(Object.keys(result.rows[0])).toEqual(["paid_at", "razorpay_payment_id", "status", "invoice", "org", "amount", "currency", "amount_inr", "razorpay_fee_inr", "gst_on_fee_inr", "net_settled_inr", "method", "international", "settlement_id", "settled_at"]);
    const ours = result.rows.filter((r) => r.org === f.org.slug); expect(ours.map((r) => r.razorpay_payment_id)).toEqual([paymentData("start").id, paymentId, paymentData("end").id]);
    expect(ours[0].status).toBe("duplicate"); expect(ours[1]).toMatchObject({ invoice: 'INV-"November",1', amount: "300.00", currency: "USD", amount_inr: "25000.00", razorpay_fee_inr: "885.00", gst_on_fee_inr: "135.00", net_settled_inr: "24115.00", method: "card", international: "true", settlement_id: "setl_1", settled_at: "2026-12-02T10:00:00.000Z" });
    expect(result.stderr).toContain("duplicates to refund"); expect(await db.billingPayment.findUniqueOrThrow({ where: { id: paymentId } })).toMatchObject({ amountInr: 2500000, feeInr: 88500, taxInr: 13500 });
  });
  test("rule 34: December report reconciles January of next year and tolerates fee-fetch errors", async () => {
    await db.billingInvoice.create({ data: invoiceData() }); await db.billingPayment.create({ data: { ...paymentData(), paidAt: new Date("2026-12-31T10:00:00Z") } });
    const result = await report("2026-12"); expect(result.exitCode).toBe(0); expect(result.stderr).toContain("year=2027&month=1");
    expect(result.rows.find((r) => r.org === f.org.slug)).toMatchObject({ amount_inr: "", razorpay_fee_inr: "", gst_on_fee_inr: "", net_settled_inr: "" });
  });
  test.each(["November", "2026-1", "2026-11x"])("rule 34: fee report rejects malformed --month %s", async (month) => { const result = await report(month); expect(result.exitCode).not.toBe(0); expect(result.stderr).toContain("Use --month YYYY-MM"); });
  test.each(["2026-00", "2026-13"])("rule 34: fee report must reject out-of-range --month %s instead of silently reporting another month", async (month) => { const result = await report(month); expect(result.exitCode).not.toBe(0); });
  test("rule 34: fee report backfills missing GST even when base_amount and fee are already saved", async () => {
    await db.billingInvoice.create({ data: invoiceData() }); const paymentId = paymentData().id;
    await db.billingPayment.create({ data: { ...paymentData(), amountInr: 2500000, feeInr: 88500, taxInr: null, method: "card", international: true } });
    const result = await report("2026-11", { [`/v1/payments/${paymentId}`]: { id: paymentId, base_amount: 2500000, fee: 88500, tax: 13500, method: "card", international: true } });
    expect(result.exitCode).toBe(0); expect(result.rows.find((r) => r.razorpay_payment_id === paymentId)?.gst_on_fee_inr).toBe("135.00"); expect((await db.billingPayment.findUniqueOrThrow({ where: { id: paymentId } })).taxInr).toBe(13500);
  });
});

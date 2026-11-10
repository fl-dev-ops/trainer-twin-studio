import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import { http, HttpResponse } from "msw";
import { createPaymentLinkPurchase, linkInvoicePurchase, purchasePaid, purchaseRefunded } from "@/lib/credit-purchases";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";
import { fundOrg, grantRequests, grants, wallets } from "../setup/meteroid";
import { outsideServices } from "../flows/harness";

const scheduled: string[] = [];
mock.module("@/lib/schedule-org-credits", () => ({ scheduleOrgSync: async (orgId: string) => { scheduled.push(orgId); }, scheduleOrgUsage: async () => {} }));

describe.skipIf(!localMinutesDb)("Meteroid credit purchases (local database)", () => {
  let f: MinutesFixture;
  const outside = outsideServices();
  beforeEach(async () => { outside.start(); f = minutesFixture(); await f.create(); await fundOrg({ orgId: f.org.id, minutes: 0 }); scheduled.length = 0; });
  afterEach(async () => { await f.clean(); outside.stop(); expect(outside.unexpected).toEqual([]); outside.reset(); });
  const buy = () => createPaymentLinkPurchase({ org: f.org, credits: 100, amount: 800, currency: "INR" });
  const paid = (razorpayId: string, paymentId = `pay_${f.org.id}`) => purchasePaid({ razorpayId, paymentId, amountPaid: 80000, currency: "INR" });
  const history = () => grants.get(`customer_${f.org.id}`)!;

  test("paid grants a one-year PAID MINS pack with payment reference and stable idempotency key; retry does not double-claim", async () => {
    const purchase = await buy();
    const before = Date.now();
    expect(await paid(purchase.razorpayId!)).toEqual({ credits: 100, duplicate: false });
    const row = await db.creditPurchase.findUniqueOrThrow({ where: { id: purchase.id } });
    expect(row.paidAt).toBeInstanceOf(Date);
    expect(row).toMatchObject({ status: "paid", paymentId: `pay_${f.org.id}` });
    const request = grantRequests.at(-1)!;
    expect(request).toMatchObject({ customer: `customer_${f.org.id}`, key: `razorpay:pay_${f.org.id}`, body: { type: "PAID", credit_unit: "MINS", amount: 100, reference: `pay_${f.org.id}`, reason: `Paid ₹800 · Razorpay ${purchase.razorpayId}` } });
    expect(new Date(String(request.body.expires_at)).getTime()).toBe(row.paidAt!.getTime() + 365 * 86_400_000);
    expect(row.paidAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(String(request.body.expires_at)).getTime()).toBeLessThanOrEqual(Date.now() + 365 * 86_400_000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await paid(purchase.razorpayId!)).toEqual({ credits: 100, duplicate: true });
    expect(grantRequests.at(-1)).toEqual(request);
    expect(await db.creditPurchase.findUniqueOrThrow({ where: { id: purchase.id } })).toEqual(row);
    expect(history()).toHaveLength(1);
    expect(wallets.get(`customer_${f.org.id}`)?.balance).toBe(100);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(scheduled).toEqual([f.org.id, f.org.id]);
    await expect(paid(purchase.razorpayId!, `different_${f.org.id}`)).rejects.toMatchObject({ status: 409 });
  });

  test("an unbilled org is refused before claiming or granting", async () => {
    await db.orgBilling.delete({ where: { orgId: f.org.id } });
    const purchase = await buy();
    const requests = grantRequests.length;
    await expect(paid(purchase.razorpayId!)).rejects.toMatchObject({ status: 409 });
    expect(await db.creditPurchase.findUniqueOrThrow({ where: { id: purchase.id } })).toMatchObject({ status: "created", paymentId: null });
    expect(grantRequests).toHaveLength(requests);
  });

  test("Meteroid failure unclaims; the same payment can retry", async () => {
    const purchase = await buy();
    outside.use(http.post("https://meteroid.test/api/v1/customers/:id/credit-grants", () => HttpResponse.json({ error: "outage" }, { status: 503 })));
    await expect(paid(purchase.razorpayId!)).rejects.toThrow("503");
    expect(await db.creditPurchase.findUniqueOrThrow({ where: { id: purchase.id } })).toMatchObject({ status: "created", paymentId: null, paidAt: null });
    outside.resetHandlers();
    expect(await paid(purchase.razorpayId!)).toEqual({ credits: 100, duplicate: false });
  });

  test.each([{ amountPaid: 79999 }, { currency: "USD" }])("mismatched payment %j adds nothing", async (override) => {
    const purchase = await buy();
    await expect(purchasePaid({ razorpayId: purchase.razorpayId!, paymentId: `pay_${f.org.id}`, amountPaid: 80000, currency: "INR", ...override })).rejects.toMatchObject({ status: 422 });
    expect(await db.creditPurchase.findUniqueOrThrow({ where: { id: purchase.id } })).toMatchObject({ status: "created" });
  });

  test("refunds are logged only, leave credits and purchase unchanged; unknown payment ignored", async () => {
    const purchase = await buy(); await paid(purchase.razorpayId!);
    const before = await db.creditPurchase.findUniqueOrThrow({ where: { id: purchase.id } });
    for (let i = 0; i < 2; i++) expect(await purchaseRefunded({ refundId: "refund", paymentId: before.paymentId!, amount: 80000, currency: "INR" })).toEqual({ refundId: "refund", creditsTakenBack: 0 });
    expect(await db.creditPurchase.findUniqueOrThrow({ where: { id: purchase.id } })).toEqual(before);
    expect(wallets.get(`customer_${f.org.id}`)?.balance).toBe(100);
    expect(await purchaseRefunded({ refundId: "unknown", paymentId: "unknown", amount: 1, currency: "INR" })).toBeNull();
  });

  test.each(["issued", "paid"])("a %s invoice is linked; paid invoice grants immediately", async (status) => {
    const id = `inv_${f.org.id}`;
    outside.invoices.set(id, { id, status, amount: 80000, amount_paid: status === "paid" ? 80000 : 0, currency: "INR", payment_id: status === "paid" ? `pay_${f.org.id}` : null });
    expect(await linkInvoicePurchase({ org: f.org, invoiceId: id, credits: 100 })).toMatchObject({ status: status === "paid" ? "paid" : "created" });
    expect(wallets.get(`customer_${f.org.id}`)?.balance).toBe(status === "paid" ? 100 : 0);
    await expect(linkInvoicePurchase({ org: f.org, invoiceId: id, credits: 100 })).rejects.toMatchObject({ status: 409 });
  });

  test.each([{ credits: 0 }, { credits: 1.5 }, { currency: "EUR" }, { amount: 0.99 }, { amount: 1.001 }, { currency: "USD" }])("invalid link input %j writes nothing", async (override) => {
    await expect(createPaymentLinkPurchase({ org: f.org, credits: 100, amount: 800, currency: "INR", ...override })).rejects.toMatchObject({ status: 400 });
    expect(await db.creditPurchase.count({ where: { orgId: f.org.id } })).toBe(0);
  });
  const badPurchases = [
    ["zero credits", { credits: 0 }, "CreditPurchase_credits_check"],
    ["negative credits", { credits: -1 }, "CreditPurchase_credits_check"],
    ["zero amount", { amount: 0 }, "CreditPurchase_amount_check"],
    ["negative amount", { amount: -1 }, "CreditPurchase_amount_check"],
    ["unsupported currency", { currency: "EUR" }, "CreditPurchase_currency_check"],
    ["unknown kind", { kind: "subscription" }, "CreditPurchase_kind_check"],
    ["unknown status", { status: "failed" }, "CreditPurchase_status_check"],
    ["negative refunded amount", { refundedAmount: -1 }, "CreditPurchase_refunded_check"],
    ["refund above amount", { refundedAmount: 1001 }, "CreditPurchase_refunded_check"],
  ] as const;
  for (const [name, fields, constraint] of badPurchases) {
    test(`database CHECK rejects purchase with ${name}`, async () => {
      await expect(Promise.resolve(db.creditPurchase.create({ data: { orgId: f.org.id, credits: 10, amount: 1000, currency: "INR", kind: "payment_link", ...fields } }))).rejects.toThrow(constraint);
      expect(await db.creditPurchase.count({ where: { orgId: f.org.id } })).toBe(0);
    });
  }
});

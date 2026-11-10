import { fundOrg, availableOrgSeconds } from "../setup/meteroid";
import "./flow-env";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HttpResponse } from "msw";
import { createPaymentLinkPurchase, linkInvoicePurchase, reconcilePurchases } from "@/lib/credit-purchases";
import { } from "@/lib/minutes";
import { db, localMinutesDb, minutesFixture } from "../lib/minutes-test-db";
import { outsideServices, razorpayWebhook } from "./harness";

describe.skipIf(!localMinutesDb)("flow: lost Razorpay webhooks → report → reconcile → late delivery", () => {
  const f = minutesFixture();
  const outside = outsideServices();
  const balance = async () => (await availableOrgSeconds(f.org.id)) / 60;
  const purchases = () => db.creditPurchase.findMany({ where: { orgId: f.org.id }, orderBy: { id: "asc" } });
  const ledger = () => db.minuteLedger.findMany({ where: { orgId: f.org.id }, orderBy: { id: "asc" } });
  const reconcile = async (apply = true) => (await reconcilePurchases({ olderThanHours: 1, refundDays: 30, apply })).filter((line) => line.org === f.org.slug);
  const buy = async (ageMinutes = 120) => {
    const purchase = await createPaymentLinkPurchase({ org: f.org, credits: 100, amount: 800, currency: "INR" });
    await db.creditPurchase.update({ where: { id: purchase.id }, data: { createdAt: new Date(Date.now() - ageMinutes * 60_000) } });
    outside.paymentLinkStates.set(purchase.razorpayId!, { id: purchase.razorpayId, status: "created", amount: 80000, amount_paid: 0, currency: "INR", payments: null });
    return purchase;
  };
  const markPaid = (purchase: { id: string; razorpayId: string | null }, amount = 80000) => {
    const paymentId = `pay_${purchase.id}`;
    // An authorized attempt must not be mistaken for the captured payment.
    outside.paymentLinkStates.set(purchase.razorpayId!, { id: purchase.razorpayId, status: "paid", amount: 80000, amount_paid: amount, currency: "INR", payments: [
      { payment_id: `authorized_${purchase.id}`, amount: 80000, status: "authorized" },
      { payment_id: paymentId, amount, status: "captured" },
    ] });
    return paymentId;
  };
  const paidWebhook = (razorpayId: string, paymentId: string) => razorpayWebhook("payment_link.paid", {
    payment_link: { entity: { id: razorpayId } }, payment: { entity: { id: paymentId, amount: 80000, currency: "INR" } },
  });
  const refundWebhook = (id: string, paymentId: string, amount: number) => razorpayWebhook("refund.processed", {
    refund: { entity: { id, payment_id: paymentId, amount, currency: "INR" } },
  });
  let lost: Awaited<ReturnType<typeof buy>>;
  let lostPayment = "";
  beforeAll(async () => { outside.start(); await f.create(); await fundOrg({ orgId: f.org.id, minutes: 0 }); });
  afterAll(async () => { await f.clean(); outside.stop(); });

  test("1. a paid link with no webhook is reported without changing purchases or ledger", async () => {
    lost = await buy();
    lostPayment = markPaid(lost);
    const before = { purchases: await purchases(), ledger: await ledger() };
    expect(await reconcile(false)).toEqual([expect.objectContaining({ purchase: lost.id, razorpayId: lost.razorpayId, action: "paid", detail: expect.stringContaining("would add credits") })]);
    expect(await purchases()).toEqual(before.purchases);
    expect(await ledger()).toEqual(before.ledger);
    expect(await balance()).toBe(0);
  });

  test("2. apply credits once; a second apply and the late signed webhook are no-ops", async () => {
    expect(await reconcile()).toEqual([expect.objectContaining({ purchase: lost.id, action: "paid", detail: expect.stringContaining("credits added") })]);
    expect(await balance()).toBe(100);
    expect(await db.creditPurchase.findUniqueOrThrow({ where: { id: lost.id } })).toMatchObject({ status: "paid", paymentId: lostPayment, paidAt: expect.any(Date) });
    expect(await ledger()).toEqual([]);
    const before = { purchases: await purchases(), ledger: await ledger() };
    expect(await reconcile()).toEqual([]);
    expect(await paidWebhook(lost.razorpayId!, lostPayment)).toMatchObject({ status: 200, body: { ok: true, result: { duplicate: true } } });
    expect(await purchases()).toEqual(before.purchases);
    expect(await ledger()).toEqual(before.ledger);
    expect(await balance()).toBe(100);
  });

  test("3. a ten-minute-old paid link is not fetched; an older unpaid link stays unpaid", async () => {
    const young = await buy(10);
    markPaid(young);
    const unpaid = await buy();
    outside.razorpayReads.length = 0;
    expect(await reconcile()).toEqual([expect.objectContaining({ purchase: unpaid.id, action: "still unpaid", detail: "not paid at Razorpay" })]);
    expect(outside.razorpayReads).not.toContain(`/payment_links/${young.razorpayId}`);
    expect(outside.razorpayReads).toContain(`/payment_links/${unpaid.razorpayId}`);
    expect(await db.creditPurchase.findUniqueOrThrow({ where: { id: young.id } })).toMatchObject({ status: "created", paymentId: null });
    expect(await balance()).toBe(100);
  });

  test("4. a Dashboard invoice paid after linking is reconciled without a webhook", async () => {
    const id = `inv_${f.org.id}`;
    const invoice = { id, status: "issued", amount: 80000, amount_paid: 0, currency: "INR", short_url: null, payment_id: null };
    outside.invoices.set(id, invoice);
    const linked = await linkInvoicePurchase({ org: f.org, invoiceId: id, credits: 100 });
    await db.creditPurchase.update({ where: { id: linked.id }, data: { createdAt: new Date(Date.now() - 7_200_000) } });
    outside.invoices.set(id, { ...invoice, status: "paid", amount_paid: 80000, payment_id: `pay_${id}` });
    expect(await reconcile()).toContainEqual(expect.objectContaining({ purchase: linked.id, action: "paid" }));
    expect(await db.creditPurchase.findUniqueOrThrow({ where: { id: linked.id } })).toMatchObject({ status: "paid", paymentId: `pay_${id}` });
    expect(await balance()).toBe(200);
    expect(await ledger()).toHaveLength(0);
  });

  test("5. refunds are not fetched or reconciled, regardless of refundDays", async () => {
    outside.refunds.set(lostPayment, [{ id: "ignored", payment_id: lostPayment, amount: 80000, currency: "INR", status: "processed" }]);
    const before = await purchases();
    outside.razorpayReads.length = 0;
    expect((await reconcile()).filter((line) => line.action === "refunded")).toEqual([]);
    expect(outside.razorpayReads.some((path) => path.includes("/refunds"))).toBe(false);
    expect(await purchases()).toEqual(before);
    expect(await balance()).toBe(200);
  });

  test("6. purchases paid outside the refund window are not fetched", async () => {
    const old = await buy();
    const paymentId = markPaid(old);
    expect(await paidWebhook(old.razorpayId!, paymentId)).toMatchObject({ status: 200, body: { ok: true } });
    await db.creditPurchase.update({ where: { id: old.id }, data: { paidAt: new Date(Date.now() - 31 * 86_400_000) } });
    outside.refunds.set(paymentId, [{ id: `rfnd_old_${f.org.id}`, payment_id: paymentId, amount: 80000, currency: "INR", status: "processed" }]);
    outside.razorpayReads.length = 0;
    expect((await reconcile()).filter((line) => line.purchase === old.id)).toEqual([]);
    expect(outside.razorpayReads).not.toContain(`/payments/${paymentId}/refunds`);
    expect(await db.creditPurchase.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ status: "paid", refundedAmount: 0 });
    expect(await balance()).toBe(300);
  });

  test("7. amount mismatch and Razorpay 500 are errors, not credits; a later purchase still reconciles", async () => {
    const mismatch = await buy(180);
    markPaid(mismatch, 79999);
    const unavailable = await buy(150);
    outside.paymentLinkStates.set(unavailable.razorpayId!, HttpResponse.json({ error: { description: "fake Razorpay outage" } }, { status: 500 }));
    const healthy = await buy(120);
    const healthyPayment = markPaid(healthy);
    const lines = await reconcile();
    expect(lines.filter((line) => line.action === "error")).toEqual([
      expect.objectContaining({ purchase: mismatch.id, detail: expect.stringContaining("no credits added") }),
      expect.objectContaining({ purchase: unavailable.id, detail: expect.stringContaining("fake Razorpay outage") }),
    ]);
    expect(lines).toContainEqual(expect.objectContaining({ purchase: healthy.id, action: "paid" }));
    for (const purchase of [mismatch, unavailable]) {
      expect(await db.creditPurchase.findUniqueOrThrow({ where: { id: purchase.id } })).toMatchObject({ status: "created", paymentId: null });
    }
    expect(await db.minuteLedger.findMany({ where: { externalId: { in: [`pay_${mismatch.id}`, `pay_${unavailable.id}`] } } })).toEqual([]);
    expect(await db.minuteLedger.findMany({ where: { orgId: f.org.id, externalId: healthyPayment } })).toEqual([]);
    expect(await balance()).toBe(400);
  });

  test("8. no unexpected outside request was made", () => {
    expect(outside.unexpected).toEqual([]);
  });
});

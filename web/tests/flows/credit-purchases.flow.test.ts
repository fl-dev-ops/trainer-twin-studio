import "./flow-env";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createPaymentLinkPurchase, linkInvoicePurchase } from "@/lib/credit-purchases";
import * as externalApi from "@/lib/external-api";
import { inviteToRoleplay } from "@/lib/invite/roleplay";
import { creditsAdded, learnerBalance, orgBalanceSeconds } from "@/lib/minutes";
import { POST as assignRoleplay } from "@/app/api/v1/assignments/route";
import { POST as webhook } from "@/app/api/razorpay/webhook/route";
import { db, localMinutesDb, minutesFixture } from "../lib/minutes-test-db";
import { outsideServices, razorpayWebhook } from "./harness";

function story() {
  const f = minutesFixture();
  const outside = outsideServices();
  beforeAll(async () => { outside.start(); await f.create(); });
  afterAll(async () => { await f.clean(); outside.stop(); });
  const balance = async () => (await orgBalanceSeconds(f.org.id)) / 60;
  const buy = () => createPaymentLinkPurchase({ org: f.org, credits: 100, amount: 800, currency: "INR" });
  const paid = (id: string, paymentId: string, currency = "INR", amount = 80000) => razorpayWebhook("payment_link.paid", {
    payment_link: { entity: { id } }, payment: { entity: { id: paymentId, amount, currency } },
  });
  const refund = (id: string, paymentId: string, amount: number) => razorpayWebhook("refund.processed", {
    refund: { entity: { id, payment_id: paymentId, amount, currency: "INR" } },
  });
  return { f, outside, balance, buy, paid, refund };
}

describe.skipIf(!localMinutesDb)("flow: Dashboard GST invoices → link → pay", () => {
  const { f, outside, balance } = story();
  const invoiceId = `inv_${f.org.id}`;
  const alreadyPaidId = `${invoiceId}_paid`;
  const invoice = (id: string, status: string) => ({ id, status, amount: 80000, amount_paid: status === "paid" ? 80000 : 0, currency: "INR", short_url: `https://rzp.io/test/${id}`, payment_id: status === "paid" ? `pay_${id}` : null });
  const paid = (id: string) => razorpayWebhook("invoice.paid", {
    invoice: { entity: { id } }, payment: { entity: { id: `pay_${id}`, amount: 80000, currency: "INR" } },
  });

  test("1. an issued Dashboard invoice is linked, but gives no credits until invoice.paid", async () => {
    outside.invoices.set(invoiceId, invoice(invoiceId, "issued"));
    const linked = await linkInvoicePurchase({ org: f.org, invoiceId, credits: 100 });
    expect(linked).toMatchObject({ kind: "invoice", status: "created", razorpayId: invoiceId });
    expect(await balance()).toBe(0);
    expect((await paid(invoiceId)).body).toMatchObject({ ok: true, result: { duplicate: false } });
    expect(await balance()).toBe(100);
    expect(await db.creditPurchase.findUniqueOrThrow({ where: { id: linked.id } })).toMatchObject({ status: "paid", paymentId: `pay_${invoiceId}` });
  });

  test("2. linking the same invoice again is a 409 with no second purchase", async () => {
    await expect(linkInvoicePurchase({ org: f.org, invoiceId, credits: 100 })).rejects.toMatchObject({ status: 409 });
    expect(await db.creditPurchase.count({ where: { orgId: f.org.id } })).toBe(1);
    expect(await balance()).toBe(100);
  });

  test("3. a separately linked already-paid invoice credits immediately; its webhook is a no-op", async () => {
    outside.invoices.set(alreadyPaidId, invoice(alreadyPaidId, "paid"));
    expect(await linkInvoicePurchase({ org: f.org, invoiceId: alreadyPaidId, credits: 75 })).toMatchObject({ status: "paid" });
    expect(await balance()).toBe(175);
    expect((await paid(alreadyPaidId)).body).toMatchObject({ result: { duplicate: true } });
    expect(await balance()).toBe(175);
    expect(await creditsAdded(f.org.id)).toHaveLength(2);
  });

  test("4. a cancelled invoice cannot be linked and no unexpected service was reached", async () => {
    const id = `${invoiceId}_cancelled`;
    outside.invoices.set(id, invoice(id, "cancelled"));
    await expect(linkInvoicePurchase({ org: f.org, invoiceId: id, credits: 100 })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("cancelled") });
    expect(await db.creditPurchase.count({ where: { orgId: f.org.id } })).toBe(2);
    expect(await balance()).toBe(175);
    expect(outside.unexpected).toEqual([]);
  });
});

describe.skipIf(!localMinutesDb)("flow: USD payment link → matching currency → formatted history", () => {
  const { f, outside, balance, paid } = story();
  let linkId = "";
  const paymentId = `pay_${f.org.id}`;

  test("1. USD requires both payer email and phone before any row or outside request", async () => {
    for (const payer of [undefined, { email: f.trainer.email }, { contact: "+14155552671" }]) {
      await expect(createPaymentLinkPurchase({ org: f.org, credits: 100, amount: 99.5, currency: "USD", payer })).rejects.toMatchObject({ status: 400 });
    }
    expect(await db.creditPurchase.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(outside.paymentLinks).toHaveLength(0);
  });

  test("2. create in cents with customer and notifications; an INR payment adds nothing", async () => {
    const payer = { email: f.trainer.email, contact: "+14155552671", name: f.trainer.name };
    const purchase = await createPaymentLinkPurchase({ org: f.org, credits: 100, amount: 99.5, currency: "USD", payer });
    linkId = purchase.razorpayId!;
    expect(outside.paymentLinks).toHaveLength(1);
    expect(outside.paymentLinks[0]).toMatchObject({ currency: "USD", amount: 9950, customer: payer, notify: { email: true, sms: true }, accept_partial: false, reference_id: purchase.id, notes: { purchaseId: purchase.id, orgId: f.org.id, credits: "100" } });
    expect((await paid(linkId, paymentId, "INR", 9950)).body).toMatchObject({ ok: false, error: expect.stringContaining("no credits added") });
    expect(await balance()).toBe(0);
    expect(await creditsAdded(f.org.id)).toEqual([]);
    expect(await db.creditPurchase.findUniqueOrThrow({ where: { id: purchase.id } })).toMatchObject({ status: "created", paymentId: null });
  });

  test("3. paid in USD gives credits and the dollar note; no unexpected service calls", async () => {
    expect((await paid(linkId, paymentId, "USD", 9950)).body).toMatchObject({ ok: true, result: { duplicate: false } });
    expect(await balance()).toBe(100);
    expect(await creditsAdded(f.org.id)).toMatchObject([{ minutes: 100, note: `Paid $99.50 · Razorpay ${linkId}` }]);
    expect(outside.unexpected).toEqual([]);
  });
});

describe.skipIf(!localMinutesDb)("flow: spent purchase → refund debt → refuse invites → recover", () => {
  const { f, outside, balance, buy, paid, refund } = story();
  const paymentId = `pay_${f.org.id}`;
  const emails = [f.learner.email, `two-${f.learner.email}`, `three-${f.learner.email}`];
  const nextEmail = `next-${f.learner.email}`;
  const invite = (emails: string[]) => inviteToRoleplay({ org: f.org, by: f.trainer, agent: f.roleplay, emails, startingMinutes: 30 });

  test("1. buy 100 credits and give three learners 30 each through role-play invitations", async () => {
    const purchase = await buy();
    expect((await paid(purchase.razorpayId!, paymentId)).body).toMatchObject({ ok: true });
    expect(await invite(emails)).toMatchObject({ added: 3, emailFailures: 0 });
    expect(await balance()).toBe(10);
    for (const email of emails) expect((await learnerBalance(f.org.id, email)).balanceSeconds).toBe(1800);
    expect(outside.emails).toHaveLength(3);
  });

  test("2. full refund leaves −90; a new invite returns 409 without any writes or email", async () => {
    expect((await refund(`rfnd_${f.org.id}`, paymentId, 80000)).body).toMatchObject({ ok: true });
    expect(await balance()).toBe(-90);
    const ledger = await db.minuteLedger.count({ where: { orgId: f.org.id } });
    await expect(invite([nextEmail])).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Not enough credits") });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(ledger);
    expect(await db.rolePlayAssignment.count({ where: { orgId: f.org.id } })).toBe(3);
    expect(await db.invitation.count({ where: { organizationId: f.org.id } })).toBe(0);
    expect(outside.emails).toHaveLength(3);
  });

  test("3. a second paid purchase clears the debt and funds a new assignment", async () => {
    const purchase = await createPaymentLinkPurchase({ org: f.org, credits: 200, amount: 1600, currency: "INR" });
    expect((await paid(purchase.razorpayId!, `${paymentId}_recovery`, "INR", 160000)).body).toMatchObject({ ok: true });
    expect(await balance()).toBe(110);
    expect(await invite([nextEmail])).toMatchObject({ added: 1, emailFailures: 0 });
    expect((await learnerBalance(f.org.id, nextEmail)).balanceSeconds).toBe(1800);
    expect(await balance()).toBe(80);
    expect(await db.rolePlayAssignment.count({ where: { orgId: f.org.id } })).toBe(4);
    expect(outside.emails).toHaveLength(4);
    expect(outside.unexpected).toEqual([]);
  });
});

describe.skipIf(!localMinutesDb)("flow: untrusted, irrelevant and repeated webhooks → exactly-once credits", () => {
  const { f, outside, balance, buy, paid, refund } = story();
  let linkId = "";
  const paymentId = `pay_${f.org.id}`;

  test("1. forged signature is 401 and writes nothing", async () => {
    const purchase = await buy();
    linkId = purchase.razorpayId!;
    const raw = JSON.stringify({ event: "payment_link.paid", payload: { payment_link: { entity: { id: linkId } }, payment: { entity: { id: paymentId, amount: 80000, currency: "INR" } } } });
    const response = await webhook(new Request("http://dash.test/api/razorpay/webhook", { method: "POST", body: raw, headers: { "x-razorpay-signature": "0".repeat(64) } }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid signature" });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(await db.creditPurchase.findUniqueOrThrow({ where: { id: purchase.id } })).toMatchObject({ status: "created", paymentId: null });
  });

  test("2. unrelated events and another business's link are acknowledged and ignored", async () => {
    expect((await razorpayWebhook("payment.authorized", {})).body).toEqual({ ok: true, ignored: "payment.authorized" });
    expect((await paid(`plink_other_${f.org.id}`, `pay_other_${f.org.id}`)).body).toEqual({ ok: true, ignored: "not a credit purchase" });
    expect(await balance()).toBe(0);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  test("3. three concurrent paid deliveries produce exactly one top-up", async () => {
    const responses = await Promise.all(Array.from({ length: 3 }, () => paid(linkId, paymentId)));
    for (const response of responses) expect(response).toMatchObject({ status: 200, body: { ok: true } });
    expect(responses.filter((response) => (response.body.result as { duplicate: boolean }).duplicate === false)).toHaveLength(1);
    expect(await balance()).toBe(100);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "topup" } })).toBe(1);
  });

  test("4. an unknown payment's refund is ignored; a partial refund delivered twice is taken once", async () => {
    expect((await refund(`rfnd_unknown_${f.org.id}`, `pay_unknown_${f.org.id}`, 20000)).body).toEqual({ ok: true, ignored: "not a credit purchase" });
    expect(await balance()).toBe(100);
    const id = `rfnd_partial_${f.org.id}`;
    expect((await refund(id, paymentId, 20000)).body).toMatchObject({ result: { duplicate: false } });
    expect((await refund(id, paymentId, 20000)).body).toMatchObject({ result: { duplicate: true } });
    expect(await balance()).toBe(75);
    expect(await db.creditPurchase.findUniqueOrThrow({ where: { razorpayId: linkId } })).toMatchObject({ status: "partially_refunded", refundedAmount: 20000 });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "refund" } })).toBe(1);
  });

  test("5. successive partial refunds sum to full: status refunded and exactly 100 credits taken", async () => {
    for (const [suffix, amount] of [["second", 30000], ["final", 30000]] as const) {
      expect((await refund(`rfnd_${suffix}_${f.org.id}`, paymentId, amount)).body).toMatchObject({ ok: true });
    }
    expect(await balance()).toBe(0);
    expect(await db.creditPurchase.findUniqueOrThrow({ where: { razorpayId: linkId } })).toMatchObject({ status: "refunded", refundedAmount: 80000 });
    expect((await db.minuteLedger.aggregate({ where: { orgId: f.org.id, type: "refund" }, _sum: { seconds: true } }))._sum.seconds).toBe(-6000);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "refund" } })).toBe(3);
    expect(outside.unexpected).toEqual([]);
  });
});

describe.skipIf(!localMinutesDb)("flow: partner assignment API funded by purchase → refund → 409", () => {
  const { f, outside, balance, buy, paid, refund } = story();
  const paymentId = `pay_${f.org.id}`;
  let api: ReturnType<typeof spyOn<typeof externalApi, "requireExternalApi">>;
  beforeAll(() => { api = spyOn(externalApi, "requireExternalApi").mockResolvedValue({ org: f.org, actorUserId: f.trainer.id, keyId: "flow-key" }); });
  afterAll(() => api?.mockRestore());
  const assign = (email: string) => assignRoleplay(new Request("http://dash.test/api/v1/assignments", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, scenario: f.roleplay.slug }),
  }));

  test("1. a paid purchase funds POST /api/v1/assignments and the learner gets 30", async () => {
    const purchase = await buy();
    expect((await paid(purchase.razorpayId!, paymentId)).body).toMatchObject({ ok: true });
    const response = await assign(f.learner.email);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ created: true, emailSent: true });
    expect((await learnerBalance(f.org.id, f.learner.email)).balanceSeconds).toBe(1800);
    expect(await balance()).toBe(70);
    expect(outside.emails).toHaveLength(1);
    expect(outside.emails[0].text).toContain("30 minutes");
  });

  test("2. full refund leaves debt; the same API refuses a new learner without grant, assignment or email", async () => {
    expect((await refund(`rfnd_${f.org.id}`, paymentId, 80000)).body).toMatchObject({ ok: true });
    expect(await balance()).toBe(-30);
    const response = await assign(`next-${f.learner.email}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("Not enough credits") });
    expect(await db.rolePlayAssignment.count({ where: { orgId: f.org.id } })).toBe(1);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "grant" } })).toBe(1);
    expect(outside.emails).toHaveLength(1);
    expect(outside.unexpected).toEqual([]);
  });
});

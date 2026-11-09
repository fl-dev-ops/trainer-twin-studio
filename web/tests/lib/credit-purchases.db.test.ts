import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import { POST } from "@/app/api/razorpay/webhook/route";
import { createPaymentLinkPurchase, linkInvoicePurchase, purchasePaid, purchaseRefunded } from "@/lib/credit-purchases";
import { creditsAdded, grantMinutes, learnerBalance, orgBalanceSeconds, orgCreditsAddedSeconds, refundOrg, topUpOrg } from "@/lib/minutes";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

const envKeys = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"] as const;

describe.skipIf(!localMinutesDb)("credit purchases and signed Razorpay webhooks (local database)", () => {
  let f: MinutesFixture;
  let originalFetch: typeof fetch;
  let originalEnv: (string | undefined)[];
  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    originalEnv = envKeys.map((key) => process.env[key]);
    process.env.RAZORPAY_KEY_ID = "rzp_test_credit_purchases";
    process.env.RAZORPAY_KEY_SECRET = "credit-purchases-test-key";
    process.env.RAZORPAY_WEBHOOK_SECRET = "credit-purchases-test-webhook";
    // Fail closed: every API response must be explicitly supplied by the test, never sent over the network.
    globalThis.fetch = mock(async () => { throw new Error("Unexpected fetch in credit purchases DB test"); });
    f = minutesFixture();
    await f.create();
  });
  afterEach(async () => {
    try {
      await db.creditPurchase.deleteMany({ where: { orgId: f.org.id } });
      await f.clean();
      expect(await db.creditPurchase.count({ where: { orgId: f.org.id } })).toBe(0);
      expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
      expect(await db.organization.count({ where: { id: f.org.id } })).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      envKeys.forEach((key, index) => {
        if (originalEnv[index] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[index];
      });
    }
  });

  function apiResponse(path: string, value: unknown, status = 200) {
    const stub = mock(async (url: string | URL | Request) => {
      expect(String(url)).toBe(`https://api.razorpay.com/v1${path}`);
      return Response.json(value, { status });
    });
    globalThis.fetch = stub;
    return stub;
  }
  const id = (kind: string) => `${f.org.id}-${kind}`;
  async function createLink() {
    apiResponse("/payment_links", { id: id("link"), short_url: "https://example.com/test-pay", status: "created" });
    return createPaymentLinkPurchase({ org: f.org, credits: 100, amount: 1000, currency: "INR", note: "Test purchase" });
  }
  const paidInput = () => ({ razorpayId: id("link"), paymentId: id("payment"), amountPaid: 100000, currency: "INR" });
  function paidEvent(overrides: Partial<ReturnType<typeof paidInput>> = {}, purchaseId?: string) {
    const input = { ...paidInput(), ...overrides };
    return { event: "payment_link.paid", payload: {
      payment_link: { entity: { id: input.razorpayId, notes: { purchaseId } } },
      payment: { entity: { id: input.paymentId, amount: input.amountPaid, currency: input.currency } },
    } };
  }
  async function webhook(body: unknown) {
    const raw = JSON.stringify(body);
    const signature = createHmac("sha256", "credit-purchases-test-webhook").update(raw).digest("hex");
    const response = await POST(new Request("http://localhost/api/razorpay/webhook", {
      method: "POST", body: raw, headers: { "x-razorpay-signature": signature },
    }));
    expect(response.status).toBe(200);
    return response.json();
  }
  const purchase = () => db.creditPurchase.findFirstOrThrow({ where: { orgId: f.org.id } });
  const ledger = () => db.minuteLedger.findMany({ where: { orgId: f.org.id } });
  const refundEvent = (refundId: string, amount: number, currency = "INR") => ({
    event: "refund.processed", payload: { refund: { entity: { id: refundId, payment_id: id("payment"), amount, currency } } },
  });

  test("payment link creation, signed paid webhook and retry add credits exactly once", async () => {
    const created = await createLink();
    expect(created).toMatchObject({ orgId: f.org.id, credits: 100, amount: 100000, currency: "INR", kind: "payment_link", status: "created", note: "Test purchase", razorpayId: id("link"), url: "https://example.com/test-pay" });
    expect(await ledger()).toHaveLength(0);
    expect(await webhook(paidEvent())).toEqual({ ok: true, result: { orgBalanceMinutes: 100, duplicate: false } });
    const paid = await purchase();
    expect(paid).toMatchObject({ status: "paid", paymentId: id("payment"), refundedAmount: 0 });
    expect(paid.paidAt).toBeInstanceOf(Date);
    expect(await ledger()).toMatchObject([{ type: "topup", seconds: 6000, email: null, externalId: id("payment") }]);
    expect(await webhook(paidEvent())).toEqual({ ok: true, result: { orgBalanceMinutes: 100, duplicate: true } });
    expect(await purchase()).toEqual(paid);
    expect(await ledger()).toHaveLength(1);
    expect(await orgBalanceSeconds(f.org.id)).toBe(6000);
  });

  test("a second different payment returns PurchaseError 409 and rolls back its topup; webhook acknowledges it", async () => {
    await createLink();
    await webhook(paidEvent());
    const paid = await purchase();
    const input = { ...paidInput(), paymentId: id("second-payment") };
    await expect(purchasePaid(input)).rejects.toMatchObject({ name: "PurchaseError", status: 409 });
    expect(await webhook(paidEvent({ paymentId: input.paymentId }))).toMatchObject({ ok: false, error: expect.stringContaining("was already paid") });
    expect(await purchase()).toEqual(paid);
    expect(await ledger()).toHaveLength(1);
    expect(await orgBalanceSeconds(f.org.id)).toBe(6000);
  });

  test.each([{ amountPaid: 99999 }, { currency: "USD" }])("wrong payment %j is a 422, acknowledged without credits or purchase mutation", async (overrides) => {
    await createLink();
    const before = await purchase();
    await expect(purchasePaid({ ...paidInput(), ...overrides })).rejects.toMatchObject({ name: "PurchaseError", status: 422 });
    expect(await webhook(paidEvent(overrides))).toMatchObject({ ok: false, error: expect.stringContaining("no credits added") });
    expect(await purchase()).toEqual(before);
    expect(await ledger()).toHaveLength(0);
    expect(await orgBalanceSeconds(f.org.id)).toBe(0);
  });

  test("purchaseId notes find our purchase before the Razorpay link id has been stored", async () => {
    const created = await createLink();
    await db.creditPurchase.update({ where: { id: created.id }, data: { razorpayId: null } });
    expect(await webhook(paidEvent({}, created.id))).toMatchObject({ ok: true, result: { duplicate: false } });
    expect(await purchase()).toMatchObject({ status: "paid", razorpayId: id("link") });
    expect(await orgBalanceSeconds(f.org.id)).toBe(6000);
  });

  test.each(["paid", "issued"])("linking a %s invoice credits immediately or through invoice.paid, once", async (status) => {
    const invoiceId = id("invoice");
    apiResponse(`/invoices/${invoiceId}`, {
      id: invoiceId, status, amount: 5000, amount_paid: status === "paid" ? 5000 : 0,
      currency: "USD", payment_id: status === "paid" ? id("payment") : null, short_url: "https://example.com/invoice",
    });
    const linked = await linkInvoicePurchase({ org: f.org, invoiceId, credits: 25, note: "Invoice test" });
    expect(linked).toMatchObject({ kind: "invoice", amount: 5000, credits: 25, currency: "USD", status: status === "paid" ? "paid" : "created", note: "Invoice test" });
    expect(await orgBalanceSeconds(f.org.id)).toBe(status === "paid" ? 1500 : 0);
    const event = { event: "invoice.paid", payload: {
      invoice: { entity: { id: invoiceId } }, payment: { entity: { id: id("payment"), amount: 5000, currency: "USD" } },
    } };
    expect(await webhook(event)).toEqual({ ok: true, result: { orgBalanceMinutes: 25, duplicate: status === "paid" } });
    expect(await webhook(event)).toMatchObject({ result: { duplicate: true } });
    expect(await purchase()).toMatchObject({ status: "paid", paymentId: id("payment") });
    expect(await ledger()).toHaveLength(1);
    expect(await orgBalanceSeconds(f.org.id)).toBe(1500);
    await expect(linkInvoicePurchase({ org: f.org, invoiceId, credits: 25 })).rejects.toMatchObject({ name: "PurchaseError", status: 409, message: expect.stringContaining("already linked") });
    expect(await db.creditPurchase.count({ where: { orgId: f.org.id } })).toBe(1);
  });

  test.each(["cancelled", "expired", "deleted", "unsupported currency"])("refuses invoice %s before creating a purchase", async (reason) => {
    const invoiceId = id("invoice");
    apiResponse(`/invoices/${invoiceId}`, {
      id: invoiceId, status: reason === "unsupported currency" ? "issued" : reason,
      amount: 10000, amount_paid: 0, currency: reason === "unsupported currency" ? "EUR" : "INR", payment_id: null, short_url: null,
    });
    await expect(linkInvoicePurchase({ org: f.org, invoiceId, credits: 10 })).rejects.toMatchObject({ name: "PurchaseError", status: 400 });
    expect(await db.creditPurchase.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(await ledger()).toHaveLength(0);
  });

  test("partial then remaining refund uses cumulative rounding (100 credits: ₹333 → 33, ₹667 → 67), with duplicate protection", async () => {
    await createLink();
    await webhook(paidEvent());
    const first = refundEvent(id("refund-1"), 33300);
    expect(await webhook(first)).toEqual({ ok: true, result: { orgBalanceMinutes: 67, duplicate: false, credits: 33 } });
    const partial = await purchase();
    expect(partial).toMatchObject({ refundedAmount: 33300, status: "partially_refunded" });
    expect(await webhook(first)).toMatchObject({ ok: true, result: { duplicate: true } });
    expect(await purchase()).toEqual(partial);
    expect(await orgBalanceSeconds(f.org.id)).toBe(4020);
    expect(await ledger()).toHaveLength(2);
    expect(await webhook(refundEvent(id("refund-2"), 66700))).toEqual({ ok: true, result: { orgBalanceMinutes: 0, duplicate: false, credits: 67 } });
    expect(await purchase()).toMatchObject({ refundedAmount: 100000, status: "refunded" });
    const rows = await ledger();
    expect(rows.filter((row) => row.type === "refund").map((row) => row.seconds).sort((a, b) => a - b)).toEqual([-4020, -1980]);
    expect(rows.filter((row) => row.type === "refund").every((row) => row.email === null && row.externalId)).toBe(true);
    expect(await orgBalanceSeconds(f.org.id)).toBe(0);
    expect(await orgCreditsAddedSeconds(f.org.id)).toBe(0);
    expect((await creditsAdded(f.org.id)).map((row) => row.minutes).sort((a, b) => a - b)).toEqual([-67, -33, 100]);
    expect(await creditsAdded(f.org.id, f.learner.email)).toEqual([]);
  });

  test("a full refund can leave the org negative without taking away granted learner credits", async () => {
    await createLink();
    await webhook(paidEvent());
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 80 });
    expect(await webhook(refundEvent(id("refund"), 100000))).toMatchObject({ ok: true, result: { orgBalanceMinutes: -80, credits: 100 } });
    expect(await orgBalanceSeconds(f.org.id)).toBe(-4800);
    expect((await learnerBalance(f.org.id, f.learner.email)).balanceSeconds).toBe(4800);
    expect(await orgCreditsAddedSeconds(f.org.id)).toBe(0);
    expect((await creditsAdded(f.org.id, f.learner.email)).map((row) => row.minutes)).toEqual([80]);
    expect(await purchase()).toMatchObject({ status: "refunded", refundedAmount: 100000 });
  });

  test("documented shortcut: a refund rounding below one credit records neither money nor ledger", async () => {
    await createLink();
    await webhook(paidEvent());
    const before = await purchase();
    expect(await webhook(refundEvent(id("tiny-refund"), 100))).toEqual({ ok: true, result: { orgBalanceMinutes: null, duplicate: false, credits: 0 } });
    expect(await purchase()).toEqual(before);
    expect(await ledger()).toHaveLength(1);
  });

  test("wrong refund currency is a 422 and acknowledged without any mutation", async () => {
    await createLink();
    await webhook(paidEvent());
    const before = await purchase();
    await expect(purchaseRefunded({ refundId: id("refund"), paymentId: id("payment"), amount: 33300, currency: "USD" })).rejects.toMatchObject({ status: 422 });
    expect(await webhook(refundEvent(id("refund"), 33300, "USD"))).toMatchObject({ ok: false });
    expect(await purchase()).toEqual(before);
    expect(await ledger()).toHaveLength(1);
  });

  test.each(["api", "network"])("a Razorpay %s failure deletes the newly created purchase", async (failure) => {
    const checkRowThenFail = async () => {
      expect(await db.creditPurchase.count({ where: { orgId: f.org.id } })).toBe(1);
      if (failure === "network") throw new Error("Test network failure");
      return Response.json({ error: { description: "Test Razorpay failure" } }, { status: 502 });
    };
    globalThis.fetch = mock(checkRowThenFail);
    await expect(createPaymentLinkPurchase({ org: f.org, credits: 10, amount: 100, currency: "INR" })).rejects.toThrow(failure === "network" ? "Test network failure" : "Test Razorpay failure");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(await db.creditPurchase.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(await ledger()).toHaveLength(0);
  });

  test.each([
    { credits: 0 }, { credits: 1.5 }, { currency: "EUR" }, { amount: 0.99 }, { amount: 1.001 },
    { currency: "USD" }, { currency: "USD", payer: { email: "payer@example.com" } }, { currency: "USD", payer: { contact: "+15555550123" } },
  ])("invalid payment link input %j creates no purchase and never fetches", async (overrides) => {
    await expect(createPaymentLinkPurchase({ org: f.org, credits: 10, amount: 100, currency: "INR", ...overrides })).rejects.toMatchObject({ name: "PurchaseError", status: 400 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(await db.creditPurchase.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  test("USD purchase requires and forwards both payer email and phone, with purchase notes", async () => {
    apiResponse("/payment_links", { id: id("link"), short_url: "https://example.com/test-pay" });
    const payer = { email: "payer@example.com", contact: "+15555550123", name: "Test payer" };
    const created = await createPaymentLinkPurchase({ org: f.org, credits: 25, amount: 99.5, currency: "USD", payer });
    expect(created).toMatchObject({ amount: 9950, currency: "USD", credits: 25 });
    expect(globalThis.fetch).toHaveBeenCalledWith("https://api.razorpay.com/v1/payment_links", expect.objectContaining({
      body: JSON.stringify({ amount: 9950, currency: "USD", accept_partial: false, description: `25 TrainerTwin credits for ${f.org.name}`, reference_id: created.id,
        notes: { purchaseId: created.id, orgId: f.org.id, credits: "25" }, customer: payer, notify: { email: true, sms: true } }),
    }));
  });

  test.each([null, "bad-signature"])("missing/bad signature %s returns 401 with no writes", async (signature) => {
    await createLink();
    const response = await POST(new Request("http://localhost/api/razorpay/webhook", {
      method: "POST", body: JSON.stringify(paidEvent()), headers: signature ? { "x-razorpay-signature": signature } : {},
    }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid signature" });
    expect(await ledger()).toHaveLength(0);
    expect(await purchase()).toMatchObject({ status: "created" });
  });

  test("unknown events and purchases are acknowledged and ignored", async () => {
    expect(await webhook({ event: "payment.authorized" })).toEqual({ ok: true, ignored: "payment.authorized" });
    expect(await webhook({})).toEqual({ ok: true, ignored: "unknown" });
    expect(await webhook(paidEvent())).toEqual({ ok: true, ignored: "not a credit purchase" });
    expect(await webhook({ event: "invoice.paid", payload: { invoice: { entity: { id: id("invoice") } }, payment: { entity: { id: id("payment"), amount: 100000, currency: "INR" } } } })).toEqual({ ok: true, ignored: "not a credit purchase" });
    expect(await webhook(refundEvent(id("refund"), 100000))).toEqual({ ok: true, ignored: "not a credit purchase" });
    expect(await ledger()).toHaveLength(0);
  });

  test("org A's paid and refund webhooks never alter org B's purchase, ledger or balance", async () => {
    const other = minutesFixture();
    try {
      await other.create();
      const otherPurchase = await db.creditPurchase.create({ data: { orgId: other.org.id, credits: 40, amount: 40000, currency: "INR", kind: "payment_link", razorpayId: `${other.org.id}-link` } });
      await topUpOrg({ orgId: other.org.id, minutes: 12, note: "Other org" });
      const before = await db.minuteLedger.findMany({ where: { orgId: other.org.id } });
      await createLink();
      // A valid Razorpay id takes precedence over another purchaseId supplied in notes.
      await webhook(paidEvent({}, otherPurchase.id));
      await webhook(refundEvent(id("refund"), 33300));
      expect(await orgBalanceSeconds(f.org.id)).toBe(4020);
      expect(await orgBalanceSeconds(other.org.id)).toBe(720);
      expect(await db.minuteLedger.findMany({ where: { orgId: other.org.id } })).toEqual(before);
      expect(await db.creditPurchase.findUnique({ where: { id: otherPurchase.id } })).toEqual(otherPurchase);
    } finally {
      await db.creditPurchase.deleteMany({ where: { orgId: other.org.id } });
      await other.clean();
    }
  });

  test("two identical paid webhooks concurrently write one topup", async () => {
    await createLink();
    const results = await Promise.all([webhook(paidEvent()), webhook(paidEvent())]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.map((result) => result.result.duplicate).sort()).toEqual([false, true]);
    expect(await ledger()).toHaveLength(1);
    expect(await orgBalanceSeconds(f.org.id)).toBe(6000);
    expect(await purchase()).toMatchObject({ status: "paid", paymentId: id("payment") });
  });

  test.each(["topup", "refund"] as const)("%s externalId skips alongside on retry and rolls back on an alongside error", async (type) => {
    const move = type === "topup" ? topUpOrg : refundOrg;
    const alongside = mock(async () => {});
    const input = { orgId: f.org.id, minutes: 10, note: "Atomic movement", externalId: id(type), alongside };
    const balance = type === "topup" ? 10 : -10;
    expect(await move(input)).toEqual({ orgBalanceMinutes: balance, duplicate: false });
    const rows = await ledger();
    expect(await move(input)).toEqual({ orgBalanceMinutes: balance, duplicate: true });
    expect(alongside).toHaveBeenCalledTimes(1);
    expect(await ledger()).toEqual(rows);
    const failedId = id(`${type}-failed`);
    await expect(move({ ...input, externalId: failedId, alongside: async (tx) => {
      await tx.creditPurchase.create({ data: { orgId: f.org.id, credits: 10, amount: 1000, currency: "INR", kind: "payment_link" } });
      throw new Error("Test alongside failure");
    } })).rejects.toThrow("Test alongside failure");
    expect(await ledger()).toEqual(rows);
    expect(await db.creditPurchase.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(await orgBalanceSeconds(f.org.id)).toBe(balance * 60);
    await expect(Promise.resolve(db.minuteLedger.create({ data: { orgId: f.org.id, type: "topup", seconds: 60, externalId: id(type) } }))).rejects.toMatchObject({ code: "P2002" });
  });

  const badRefunds = [
    ["email", { email: "test@example.com", seconds: -60, externalId: "provided" }, "MinuteLedger_holder_check"],
    ["missing externalId", { seconds: -60 }, "MinuteLedger_refund_external_check"],
    ["positive seconds", { seconds: 60, externalId: "provided" }, "MinuteLedger_sign_check"],
  ] as const;
  for (const [name, fields, constraint] of badRefunds) {
    test(`database CHECK rejects refund with ${name}`, async () => {
      await expect(Promise.resolve(db.minuteLedger.create({ data: { orgId: f.org.id, type: "refund", ...fields, externalId: "externalId" in fields ? id("bad-refund") : undefined } }))).rejects.toThrow(constraint);
      expect(await ledger()).toHaveLength(0);
    });
  }

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

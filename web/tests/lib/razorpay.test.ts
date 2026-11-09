import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createPaymentLink, fetchInvoice, RazorpayError, verifyWebhookSignature } from "@/lib/razorpay";

const keys = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"] as const;
let originalEnv: (string | undefined)[];
let originalFetch: typeof fetch;

beforeEach(() => {
  originalEnv = keys.map((key) => process.env[key]);
  originalFetch = globalThis.fetch;
  process.env.RAZORPAY_KEY_ID = "rzp_test_credits";
  process.env.RAZORPAY_KEY_SECRET = "test-key-secret";
  process.env.RAZORPAY_WEBHOOK_SECRET = "test-webhook-secret";
  globalThis.fetch = mock(async () => { throw new Error("Unexpected fetch in Razorpay test"); });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  keys.forEach((key, index) => {
    if (originalEnv[index] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[index];
  });
});

describe("verifyWebhookSignature", () => {
  const raw = '{ "event": "payment_link.paid" }';
  const signature = () => createHmac("sha256", "test-webhook-secret").update(raw).digest("hex");
  test("accepts an HMAC-SHA256 hex signature of the exact raw body", () => {
    expect(verifyWebhookSignature(raw, signature())).toBe(true);
    expect(verifyWebhookSignature(JSON.stringify(JSON.parse(raw)), signature())).toBe(false);
    process.env.RAZORPAY_WEBHOOK_SECRET = "different-secret";
    expect(verifyWebhookSignature(raw, signature())).toBe(false);
  });
  test.each([null, "", "short", "0".repeat(64), "g".repeat(64), "a".repeat(65)])("refuses missing or wrong signature %s", (signature) => {
    expect(verifyWebhookSignature(raw, signature)).toBe(false);
  });
  test("fails closed when a signature is supplied but the secret is missing", () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    expect(() => verifyWebhookSignature(raw, signature())).toThrow("RAZORPAY_WEBHOOK_SECRET is not set");
  });
});

describe("Razorpay REST requests (stubbed fetch only)", () => {
  const input = {
    amount: 9950, currency: "USD", description: "100 credits", referenceId: "purchase-test",
    notes: { purchaseId: "purchase-test", orgId: "org-test", credits: "100" },
  };
  test.each([
    { email: "payer@example.com", contact: "+15555550123", name: "Payer" },
    { email: "payer@example.com" },
    { contact: "+15555550123" },
    undefined,
  ])("createPaymentLink sends amount, notes, Basic auth and only the requested notifications: %j", async (customer) => {
    const link = { id: "plink-test", short_url: "https://example.com/pay", amount: 9950, currency: "USD", status: "created" };
    const fetchStub = mock(async () => Response.json(link));
    globalThis.fetch = fetchStub;
    expect(await createPaymentLink({ ...input, customer })).toEqual(link);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub).toHaveBeenCalledWith("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from("rzp_test_credits:test-key-secret").toString("base64")}`, "content-type": "application/json" },
      body: JSON.stringify({
        amount: input.amount, currency: input.currency, accept_partial: false, description: input.description,
        reference_id: input.referenceId, notes: input.notes,
        ...(customer ? { customer, notify: { email: Boolean(customer.email), sms: Boolean(customer.contact) } } : {}),
      }),
    });
  });
  test("fetchInvoice encodes the id and uses an authenticated GET", async () => {
    const invoice = { id: "inv/test?", status: "issued", amount: 10000, amount_paid: 0, currency: "INR", short_url: null, payment_id: null };
    const fetchStub = mock(async () => Response.json(invoice));
    globalThis.fetch = fetchStub;
    expect(await fetchInvoice(invoice.id)).toEqual(invoice);
    expect(fetchStub).toHaveBeenCalledWith("https://api.razorpay.com/v1/invoices/inv%2Ftest%3F", {
      method: "GET", headers: { authorization: `Basic ${Buffer.from("rzp_test_credits:test-key-secret").toString("base64")}` }, body: undefined,
    });
  });
  test("surfaces Razorpay's error description and status", async () => {
    globalThis.fetch = mock(async () => Response.json({ error: { description: "Invalid customer" } }, { status: 400 }));
    await expect(createPaymentLink(input)).rejects.toBeInstanceOf(RazorpayError);
    await expect(createPaymentLink(input)).rejects.toMatchObject({ status: 400, message: "Razorpay /payment_links: Invalid customer" });
  });
  test("handles a non-JSON error response", async () => {
    globalThis.fetch = mock(async () => new Response("unavailable", { status: 503, statusText: "Service Unavailable" }));
    await expect(fetchInvoice("inv-test")).rejects.toMatchObject({ status: 503, message: "Razorpay /invoices/inv-test: Service Unavailable" });
  });
  test.each(["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"] as const)("refuses missing %s without fetching", async (key) => {
    delete process.env[key];
    await expect(createPaymentLink(input)).rejects.toThrow(`${key} is not set`);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

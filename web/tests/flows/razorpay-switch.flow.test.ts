import "./flow-env";
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import * as razorpay from "@/lib/razorpay";
import { POST } from "@/app/api/razorpay/webhook/route";
import { outsideServices, razorpayWebhook } from "./harness";

const outside = outsideServices();
const keys = ["RAZORPAY_ENABLED", "RAZORPAY_WEBHOOK_SECRET"] as const;
let originalEnv: (string | undefined)[];
let verification: ReturnType<typeof spyOn<typeof razorpay, "verifyWebhookSignature">>;
const input = { amount: 80000, currency: "INR", description: "100 credits", referenceId: "switch-test", notes: {} };

beforeAll(() => outside.start());
afterAll(() => outside.stop());
beforeEach(() => {
  originalEnv = keys.map((key) => process.env[key]);
  outside.reset();
  verification = spyOn(razorpay, "verifyWebhookSignature");
});
afterEach(() => {
  verification.mockRestore();
  keys.forEach((key, index) => {
    if (originalEnv[index] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[index];
  });
  expect(outside.unexpected).toEqual([]);
});

test.each([undefined, "false"])("Razorpay disabled (%j) refuses every API call and hides the webhook before verification", async (enabled) => {
  if (enabled === undefined) delete process.env.RAZORPAY_ENABLED;
  else process.env.RAZORPAY_ENABLED = enabled;
  delete process.env.RAZORPAY_WEBHOOK_SECRET;

  await expect(razorpay.createPaymentLink(input)).rejects.toBeInstanceOf(razorpay.RazorpayDisabledError);
  await expect(razorpay.fetchInvoice("inv_switch")).rejects.toBeInstanceOf(razorpay.RazorpayDisabledError);
  await expect(razorpay.fetchPaymentLink("plink_switch")).rejects.toBeInstanceOf(razorpay.RazorpayDisabledError);
  await expect(razorpay.fetchRefunds("pay_switch")).rejects.toBeInstanceOf(razorpay.RazorpayDisabledError);
  expect(outside.paymentLinks).toEqual([]);
  expect(outside.razorpayReads).toEqual([]);

  const request = new Request("http://dash.test/api/razorpay/webhook", {
    method: "POST", body: "not JSON", headers: { "x-razorpay-signature": "0".repeat(64) },
  });
  const response = await POST(request);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "Not found" });
  expect(request.bodyUsed).toBe(false);
  expect(verification).not.toHaveBeenCalled();
});

test("Razorpay enabled preserves API requests and signature-checked webhook behaviour", async () => {
  process.env.RAZORPAY_ENABLED = "true";
  const invoice = { id: "inv_switch", status: "issued", amount: 80000, amount_paid: 0, currency: "INR", short_url: null, payment_id: null };
  outside.invoices.set(invoice.id, invoice);
  expect(await razorpay.createPaymentLink(input)).toMatchObject({ id: "plink_flow_switch-test", amount: 80000 });
  expect(await razorpay.fetchInvoice(invoice.id)).toEqual(invoice);
  expect(outside.paymentLinks).toHaveLength(1);
  expect(outside.razorpayReads).toEqual(["/invoices/inv_switch"]);

  const rejected = await POST(new Request("http://dash.test/api/razorpay/webhook", {
    method: "POST", body: "{}", headers: { "x-razorpay-signature": "0".repeat(64) },
  }));
  expect(rejected.status).toBe(401);
  expect(await rejected.json()).toEqual({ error: "Invalid signature" });
  expect(await razorpayWebhook("payment.authorized", {})).toEqual({ status: 200, body: { ok: true, ignored: "payment.authorized" } });
  expect(verification).toHaveBeenCalledTimes(2);
});

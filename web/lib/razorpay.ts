import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The few Razorpay calls credit purchases need (lib/credit-purchases.ts), over its REST API with the key pair:
 * payment links, invoices, and the webhook signature. Test keys (rzp_test_…) locally, live keys in production.
 */

const API = "https://api.razorpay.com/v1";

function env(name: "RAZORPAY_KEY_ID" | "RAZORPAY_KEY_SECRET" | "RAZORPAY_WEBHOOK_SECRET") {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export class RazorpayError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "RazorpayError";
  }
}

async function call<T>(path: string, init?: { method: "POST"; body: unknown }): Promise<T> {
  const auth = Buffer.from(`${env("RAZORPAY_KEY_ID")}:${env("RAZORPAY_KEY_SECRET")}`).toString("base64");
  const response = await fetch(`${API}${path}`, {
    method: init?.method ?? "GET",
    headers: { authorization: `Basic ${auth}`, ...(init ? { "content-type": "application/json" } : {}) },
    body: init ? JSON.stringify(init.body) : undefined,
  });
  const body = await response.json().catch(() => null) as { error?: { description?: string } } | null;
  if (!response.ok) throw new RazorpayError(`Razorpay ${path}: ${body?.error?.description ?? response.statusText}`, response.status);
  return body as T;
}

export type RazorpayPaymentLink = { id: string; short_url: string; amount: number; currency: string; status: string };

/** A payment link for one amount (no partial payments), notes carried back on its webhook. */
export function createPaymentLink(input: {
  amount: number;
  currency: string;
  description: string;
  referenceId: string;
  notes: Record<string, string>;
  customer?: { email?: string; contact?: string; name?: string };
}) {
  return call<RazorpayPaymentLink>("/payment_links", {
    method: "POST",
    body: {
      amount: input.amount,
      currency: input.currency,
      accept_partial: false,
      description: input.description,
      reference_id: input.referenceId,
      notes: input.notes,
      ...(input.customer ? { customer: input.customer, notify: { email: Boolean(input.customer.email), sms: Boolean(input.customer.contact) } } : {}),
    },
  });
}

export type RazorpayLinkPayment = { payment_id: string; amount: number; status: string };
export type RazorpayPaymentLinkState = RazorpayPaymentLink & { amount_paid: number; payments: RazorpayLinkPayment[] | null };

/** A payment link as it stands now, with the payments made on it (reconciliation). */
export function fetchPaymentLink(id: string) {
  return call<RazorpayPaymentLinkState>(`/payment_links/${encodeURIComponent(id)}`);
}

export type RazorpayRefund = { id: string; payment_id: string; amount: number; currency: string; status: string };

/** A payment's refunds (reconciliation). */
export async function fetchRefunds(paymentId: string) {
  return (await call<{ items: RazorpayRefund[] }>(`/payments/${encodeURIComponent(paymentId)}/refunds`)).items;
}

export type RazorpayInvoice = { id: string; status: string; amount: number; amount_paid: number; currency: string; short_url: string | null; payment_id: string | null };

export function fetchInvoice(id: string) {
  return call<RazorpayInvoice>(`/invoices/${encodeURIComponent(id)}`);
}

/** Whether a webhook body came from Razorpay: HMAC-SHA256 of the raw body with the webhook secret, hex. */
export function verifyWebhookSignature(rawBody: string, signature: string | null) {
  if (!signature) return false;
  const expected = createHmac("sha256", env("RAZORPAY_WEBHOOK_SECRET")).update(rawBody).digest("hex");
  const given = Buffer.from(signature, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

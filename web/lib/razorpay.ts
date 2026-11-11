import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The Razorpay calls the app needs, over its REST API with the key pair: payment links for invoices (billing phase 3,
 * lib/billing/razorpay.ts) and for phase 1 credit purchases (lib/credit-purchases.ts), payments and their fees,
 * settlements, and the webhook signature. Test keys (rzp_test_…) locally, live keys in production.
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

async function call<T>(path: string, init?: { method: "POST"; body?: unknown }): Promise<T> {
  const auth = Buffer.from(`${env("RAZORPAY_KEY_ID")}:${env("RAZORPAY_KEY_SECRET")}`).toString("base64");
  const response = await fetch(`${API}${path}`, {
    method: init?.method ?? "GET",
    headers: { authorization: `Basic ${auth}`, ...(init?.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
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

/**
 * A payment link for an invoice (billing phase 3): no partial payments, no expiry, Razorpay sends nothing (our emails
 * do), and after paying the payer comes back to `callbackUrl`. `referenceId` is unique in the account: a second
 * create with it fails, so a retry looks the first one up (`paymentLinkByReference`).
 */
export function createInvoicePaymentLink(input: {
  amount: number;
  currency: string;
  description: string;
  referenceId: string;
  notes: Record<string, string>;
  customer: { name: string; email: string; contact: string };
  callbackUrl: string;
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
      customer: input.customer,
      notify: { email: false, sms: false },
      reminder_enable: false,
      callback_url: input.callbackUrl,
      callback_method: "get",
    },
  });
}

/** The account's payment link with this reference id, if any. */
export async function paymentLinkByReference(referenceId: string) {
  const page = await call<{ payment_links?: RazorpayPaymentLink[] }>(`/payment_links?reference_id=${encodeURIComponent(referenceId)}`);
  return page.payment_links?.find((link) => (link as { reference_id?: string }).reference_id === referenceId) ?? null;
}

/** Cancels an unpaid link (its invoice was voided or paid another way). Razorpay refuses a paid or cancelled one. */
export function cancelPaymentLink(id: string) {
  return call<RazorpayPaymentLink>(`/payment_links/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

export type RazorpayPayment = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  method: string | null;
  international: boolean;
  /** In INR paise: what the payment came to, Razorpay's fee and the GST on it (once captured). */
  base_amount?: number | null;
  fee?: number | null;
  tax?: number | null;
  created_at: number;
};

export function fetchPayment(id: string) {
  return call<RazorpayPayment>(`/payments/${encodeURIComponent(id)}`);
}

export type RazorpayReconItem = { entity_id: string; type: string; settlement_id: string | null; settled_at: number | null; settled: boolean };

/** One page of a month's settlement reconciliation: which settlement paid out each payment. */
export async function settlementRecon(year: number, month: number, skip = 0, count = 1000) {
  return (await call<{ items?: RazorpayReconItem[] }>(`/settlements/recon/combined?year=${year}&month=${month}&skip=${skip}&count=${count}`)).items ?? [];
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

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The few Meteroid calls org credits need (lib/org-credits.ts), over its REST API with an API key. Meteroid owns the
 * org's credits (MINS: 1 credit = 1 minute): grants with expiry, and the usage that spends them. Sandbox key
 * (pv_dev_…) locally, a production key in production.
 */

/** The Meteroid credit unit for practice minutes, and the usage metric the app reports to it (scripts/meteroid-setup.ts). */
export const CREDIT_UNIT = "MINS";
export const USAGE_METRIC = "voice_minutes";

function env(name: "METEROID_API_KEY" | "METEROID_WEBHOOK_SECRET") {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const apiUrl = () => (process.env.METEROID_API_URL?.trim() || "https://meteroid-rest.foreverlearning.in/api/v1").replace(/\/$/, "");

export class MeteroidError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "MeteroidError";
  }
}

export async function meteroid<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, idempotencyKey?: string, timeoutMs = 10_000): Promise<T> {
  const response = await fetch(`${apiUrl()}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env("METEROID_API_KEY")}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new MeteroidError(`Meteroid ${method} ${path}: ${response.status} ${text.slice(0, 300)}`, response.status);
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * The customer's minutes as Meteroid sees them: granted, not expired, less the usage it has counted (fractions of a
 * minute round up). `asOf`: usage sent before it is counted; usage sent after it may not be yet.
 */
export async function minutesBalance(customerId: string, timeoutMs?: number): Promise<{ minutes: number; asOf: Date }> {
  const check = await meteroid<{ balance: number; as_of?: string | null }>(
    "GET", `/customers/${encodeURIComponent(customerId)}/wallets/check?credit_unit=${CREDIT_UNIT}`, undefined, undefined, timeoutMs);
  return { minutes: check.balance, asOf: check.as_of ? new Date(check.as_of) : new Date(0) };
}

export type CreditGrant = { id: string; minutes: number; reason: string | null; expiresAt: string | null; status: string | null; createdAt: string | null };

/** The customer's minute grants (what was added to the org: free minutes, packs), newest first. */
export async function minuteGrants(customerId: string): Promise<CreditGrant[]> {
  const page = await meteroid<{ data?: Record<string, unknown>[] }>("GET", `/customers/${encodeURIComponent(customerId)}/credit-grants?per_page=100`);
  return (page.data ?? [])
    .filter((grant) => grant.credit_unit === CREDIT_UNIT)
    .map((grant) => ({
      id: String(grant.id),
      minutes: Number(grant.amount),
      reason: (grant.reason as string | null) ?? null,
      expiresAt: (grant.expires_at as string | null) ?? null,
      status: (grant.status as string | null) ?? null,
      createdAt: (grant.created_at as string | null) ?? null,
    }))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/** Adds minutes to the customer (a paid purchase, or free minutes). The key makes a retry return the first grant. */
export function grantMinutes(input: { customerId: string; minutes: number; type: "PAID" | "PROMOTIONAL"; reason: string; reference?: string; expiresAt?: Date; idempotencyKey: string }) {
  return meteroid("POST", `/customers/${encodeURIComponent(input.customerId)}/credit-grants`, {
    type: input.type,
    credit_unit: CREDIT_UNIT,
    amount: input.minutes,
    reason: input.reason,
    ...(input.reference ? { reference: input.reference } : {}),
    ...(input.expiresAt ? { expires_at: input.expiresAt.toISOString() } : {}),
  }, input.idempotencyKey);
}

export type UsageEvent = { id: string; customerId: string; minutes: number; at: Date; properties: Record<string, string> };

/** Reports usage that spends the customer's minutes. Meteroid counts an event id once, however often it's sent. */
export async function sendUsage(events: UsageEvent[]) {
  if (!events.length) return;
  await meteroid("POST", "/events/ingest", {
    events: events.map((event) => ({
      event_id: event.id,
      code: USAGE_METRIC,
      customer_id: event.customerId,
      timestamp: event.at.toISOString(),
      // Decimal string: a call's seconds as minutes (Meteroid adds them up and rounds the balance up).
      properties: { ...event.properties, minutes: String(Math.round((event.minutes + Number.EPSILON) * 10_000) / 10_000) },
    })),
  });
}

/**
 * Whether a webhook came from Meteroid (Standard Webhooks): HMAC-SHA256 of `id.timestamp.body` with the secret
 * (whsec_<base64 key>), base64, in a space-separated list of `v1,<signature>`. Older than 5 minutes: refused.
 */
export function verifyWebhook(rawBody: string, headers: Headers, now = Date.now()) {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!id || !timestamp || !signatures) return false;
  if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = Buffer.from(env("METEROID_WEBHOOK_SECRET").replace(/^whsec_/, ""), "base64");
  const wanted = Buffer.from(createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64"));
  return signatures.split(" ").some((entry) => {
    const given = Buffer.from(entry.replace(/^v1,/, ""));
    return entry.startsWith("v1,") && given.length === wanted.length && timingSafeEqual(given, wanted);
  });
}

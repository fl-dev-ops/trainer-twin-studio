import { http, HttpResponse } from "msw";
import { db } from "@/lib/db";

export const wallets = new Map<string, { balance: number; as_of: string }>();
export const grants = new Map<string, Record<string, unknown>[]>();
export const grantRequests: { customer: string; key: string | null; body: Record<string, unknown> }[] = [];
export const usageEvents: Record<string, unknown>[] = [];
const keys = new Map<string, Record<string, unknown>>();
const keyBodies = new Map<string, string>();
export const meteroidHandlers = [
  http.get("https://meteroid.test/api/v1/customers/:id/wallets/check", ({ params, request }) => {
    if (request.headers.get("authorization") !== "Bearer test-meteroid-key") return new HttpResponse(null, { status: 401 });
    const wallet = wallets.get(String(params.id));
    return wallet ? HttpResponse.json(wallet) : HttpResponse.json({ error: "unknown test customer" }, { status: 404 });
  }),
  http.get("https://meteroid.test/api/v1/customers/:id/credit-grants", ({ params }) => HttpResponse.json({ data: grants.get(String(params.id)) ?? [] })),
  http.post("https://meteroid.test/api/v1/customers/:id/credit-grants", async ({ params, request }) => {
    const customer = String(params.id);
    const body = await request.json() as Record<string, unknown>;
    const key = request.headers.get("idempotency-key");
    grantRequests.push({ customer, key, body });
    if (key && keys.has(key)) {
      if (keyBodies.get(key) !== JSON.stringify(body)) return HttpResponse.json({ error: "Idempotency key reused with different body" }, { status: 409 });
      return HttpResponse.json(keys.get(key)!);
    }
    const grant = { id: `grant_${grantRequests.length}`, status: "ACTIVE", created_at: new Date().toISOString(), ...body };
    const wallet = wallets.get(customer);
    if (!wallet) return new HttpResponse(null, { status: 404 });
    wallet.balance += Number(body.amount);
    grants.set(customer, [...(grants.get(customer) ?? []), grant]);
    if (key) { keys.set(key, grant); keyBodies.set(key, JSON.stringify(body)); }
    return HttpResponse.json(grant);
  }),
  http.post("https://meteroid.test/api/v1/events/ingest", async ({ request }) => {
    const body = await request.json() as { events: Record<string, unknown>[] };
    usageEvents.push(...body.events);
    return HttpResponse.json({});
  }),
];

/** Adds fake Meteroid credits; no org-owned MinuteLedger rows. */
export async function fundOrg(input: { orgId: string; minutes: number; note?: string }) {
  const customer = `customer_${input.orgId}`;
  const wallet = wallets.get(customer) ?? { balance: 0, as_of: new Date(0).toISOString() };
  wallet.balance += input.minutes;
  wallets.set(customer, wallet);
  const grant = { id: `seed_${customer}_${grants.get(customer)?.length ?? 0}`, amount: input.minutes, credit_unit: "MINS", reason: input.note ?? "test", status: "ACTIVE", expires_at: null, created_at: new Date().toISOString() };
  const history = input.minutes ? [...(grants.get(customer) ?? []), grant] : (grants.get(customer) ?? []);
  grants.set(customer, history);
  const data = { meteroidCustomerId: customer, balanceMinutes: wallet.balance, balanceAsOf: new Date(wallet.as_of), syncedAt: new Date(), grants: history.map((g) => ({ id: String(g.id), minutes: Number(g.amount), reason: String(g.reason), status: String(g.status), expiresAt: g.expires_at ? String(g.expires_at) : null, createdAt: String(g.created_at) })) };
  await db.orgBilling.upsert({ where: { orgId: input.orgId }, create: { orgId: input.orgId, ...data }, update: data });
}

export async function availableOrgSeconds(orgId: string) {
  const { orgCredits } = await import("@/lib/org-credits");
  return (await orgCredits(orgId, { fresh: true })).seconds;
}

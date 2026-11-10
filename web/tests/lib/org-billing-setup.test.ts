import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MeteroidError } from "@/lib/meteroid";
import { orgBillingService } from "../setup/org-billing";

const org = { id: "org-onboarding", slug: "training", name: "Training" };
const service = orgBillingService();
const server = setupServer(...service.handlers);
const base = "https://meteroid.test/api/v1";
const upsert = mock(async (_input: unknown) => ({}));
mock.module("@/lib/db", () => ({ db: { orgBilling: { upsert } } }));
const { linkOrgToMeteroid, unlinkOrgFromMeteroid, grantTrialMinutes } = await import("@/lib/org-billing-setup");
beforeAll(() => { server.listen({ onUnhandledRequest: "error" }); });
afterAll(() => { server.close(); });
beforeEach(() => {
  service.requests.length = 0; service.grants.length = 0;
  upsert.mockClear();
});
afterEach(() => { server.resetHandlers(); });
const writes = () => service.requests.filter((r) => r.method !== "GET");

test("linkOrgToMeteroid creates customer and Credits subscription with stable key, then upserts billing", async () => {
  expect(await linkOrgToMeteroid(org)).toEqual({ customerId: "customer-onboarding", subscriptionId: "subscription-credits" });
  expect(writes()).toEqual([
    { method: "POST", path: "/customers", key: null, body: { name: org.name, alias: org.slug, currency: "USD", customer_type: "COMPANY" } },
    { method: "POST", path: "/subscriptions", key: `credits-subscription-${org.id}`, body: {
      customer_id_or_alias: org.slug, plan_id: "plan-credits", start_date: new Date().toISOString().slice(0, 10), activation_condition: "ON_START", charge_automatically: false,
    } },
  ]);
  expect(upsert).toHaveBeenCalledTimes(1);
  expect(upsert).toHaveBeenCalledWith({ where: { orgId: org.id }, create: { orgId: org.id, meteroidCustomerId: "customer-onboarding" }, update: { meteroidCustomerId: "customer-onboarding" } });
});
test.each(["ACTIVE", "TRIALING", "PENDING_ACTIVATION"])("linkOrgToMeteroid reuses %s metric-counting subscription and existing customer", async (status) => {
  server.use(
    http.get(`${base}/customers/${org.slug}`, () => HttpResponse.json({ id: "existing-customer" })),
    http.get(`${base}/subscriptions`, ({ request }) => {
      expect(new URL(request.url).searchParams.get("customer_id")).toBe("existing-customer");
      return HttpResponse.json({ data: [{ id: "existing-sub", plan_id: "plan-credits", status }, { id: "ended-sub", plan_id: "ignored", status: "ENDED" }] });
    }),
  );
  for (let repeat = 0; repeat < 2; repeat++) expect(await linkOrgToMeteroid(org)).toEqual({ customerId: "existing-customer", subscriptionId: "existing-sub" });
  expect(writes()).toEqual([]);
  expect(upsert).toHaveBeenCalledTimes(2);
  expect(upsert).toHaveBeenLastCalledWith(expect.objectContaining({ update: { meteroidCustomerId: "existing-customer" } }));
});
test("non-counting active subscriptions do not replace the Credits subscription", async () => {
  server.use(
    http.get(`${base}/subscriptions`, () => HttpResponse.json({ data: [{ id: "wrong-sub", plan_id: "other", status: "ACTIVE" }] })),
    http.get(`${base}/plans/other`, () => HttpResponse.json({ price_components: [{ fee: { metric_id: "not-voice" } }] })),
    http.post(`${base}/subscriptions`, () => HttpResponse.json({ id: "new-sub" })),
  );
  expect(await linkOrgToMeteroid(org)).toMatchObject({ subscriptionId: "new-sub" });
});
test.each(["metric", "plan", "subscription"])("linkOrgToMeteroid refuses missing %s before writing OrgBilling", async (missing) => {
  if (missing === "metric") server.use(http.get(`${base}/metrics`, () => HttpResponse.json({ data: [{ id: "archived", code: "voice_minutes", archived_at: "2026-01-01" }] })));
  if (missing === "plan") server.use(http.get(`${base}/plans`, () => HttpResponse.json({ data: [] })));
  if (missing === "subscription") server.use(http.post(`${base}/subscriptions`, () => HttpResponse.json({})));
  await expect(linkOrgToMeteroid(org)).rejects.toThrow(missing === "metric" ? "no voice_minutes metric" : missing === "plan" ? 'no "Credits" plan' : "created no subscription");
  expect(upsert).not.toHaveBeenCalled();
});
test("customer errors other than 404 propagate rather than creating duplicates", async () => {
  server.use(http.get(`${base}/customers/${org.slug}`, () => HttpResponse.json({ error: "unavailable" }, { status: 503 })));
  await expect(linkOrgToMeteroid(org)).rejects.toMatchObject({ name: "MeteroidError", status: 503 });
  expect(writes()).toEqual([]);
  expect(upsert).not.toHaveBeenCalled();
});
test("unlinkOrgFromMeteroid cancels live subscriptions, frees alias, retries archive 400 then succeeds", async () => {
  server.use(http.get(`${base}/subscriptions`, () => HttpResponse.json({ data: [
    { id: "active", status: "ACTIVE" }, { id: "pending", status: "PENDING_ACTIVATION" }, { id: "cancelled", status: "CANCELLED" }, { id: "ended", status: "ENDED" },
  ] })));
  let deletes = 0;
  server.use(http.delete(`${base}/customers/customer`, () => {
    deletes++;
    return deletes < 3 ? HttpResponse.json({}, { status: 400 }) : new HttpResponse(null, { status: 204 });
  }));
  const originalTimeout = globalThis.setTimeout;
  const sleeps: number[] = [];
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms === 1000) { sleeps.push(ms); return originalTimeout(fn, 0, ...args); }
    return originalTimeout(fn, ms, ...args);
  }) as typeof setTimeout);
  try { await unlinkOrgFromMeteroid("customer"); } finally { timeout.mockRestore(); }
  expect(writes()).toEqual([
    ...["active", "pending"].map((id) => ({ method: "POST", path: `/subscriptions/${id}/cancel`, key: null, body: { effective_date: new Date().toISOString().slice(0, 10), reason: "Onboarding failed" } })),
    { method: "PATCH", path: "/customers/customer", key: null, body: { alias: "customer-onboarding-failed" } },
  ]);
  expect(deletes).toBe(3);
  expect(sleeps).toEqual([1000, 1000]);
});
test("unlinkOrgFromMeteroid rethrows non-400 archive errors without retry", async () => {
  let deletes = 0;
  server.use(http.delete(`${base}/customers/customer`, () => { deletes++; return HttpResponse.json({}, { status: 500 }); }));
  const error = await unlinkOrgFromMeteroid("customer").catch((error: unknown) => error);
  expect(error).toBeInstanceOf(MeteroidError);
  expect(error).toMatchObject({ status: 500 });
  expect(deletes).toBe(1);
  expect(writes()).toEqual([{ method: "PATCH", path: "/customers/customer", key: null, body: { alias: "customer-onboarding-failed" } }]);
});


test.each([undefined, new Date("2026-11-11T00:00:00Z")])("grantTrialMinutes grants 30 promotional minutes for 30 days from startsAt=%j (default: creation) with identical retry bodies", async (startsAt) => {
  const trialOrg = { id: org.id, createdAt: new Date("2026-02-01T12:34:56Z") };
  const start = startsAt ?? trialOrg.createdAt;
  if (startsAt) {
    await grantTrialMinutes(trialOrg, "customer-onboarding", startsAt);
    await grantTrialMinutes(trialOrg, "customer-onboarding", startsAt);
  } else {
    await grantTrialMinutes(trialOrg, "customer-onboarding");
    await grantTrialMinutes(trialOrg, "customer-onboarding");
  }
  expect(service.requests).toHaveLength(2);
  for (const request of service.requests) {
    expect(request).toMatchObject({ method: "POST", path: "/customers/customer-onboarding/credit-grants", key: `trial-${org.id}-customer-onboarding`, body: {
      type: "PROMOTIONAL", credit_unit: "MINS", amount: 30, reason: "Free trial", expires_at: new Date(start.getTime() + 30 * 86_400_000).toISOString(),
    } });
    const expiry = new Date((request.body as { expires_at: string }).expires_at).getTime();
    expect(expiry).toBe(start.getTime() + 30 * 86_400_000);
  }
  expect(service.requests[0].body).toEqual(service.requests[1].body);
  expect(service.grants).toHaveLength(1);
  await grantTrialMinutes({ ...trialOrg, id: "another-org" }, "customer-onboarding", startsAt);
  expect(service.grants).toHaveLength(2);
});

test("unlinkOrgFromMeteroid stops after ten archive 400 responses", async () => {
  let deletes = 0;
  server.use(http.delete(`${base}/customers/customer`, () => { deletes++; return HttpResponse.json({}, { status: 400 }); }));
  const originalTimeout = globalThis.setTimeout;
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    originalTimeout(fn, ms === 1000 ? 0 : ms, ...args)) as typeof setTimeout);
  try { await expect(unlinkOrgFromMeteroid("customer")).rejects.toMatchObject({ status: 400 }); }
  finally { timeout.mockRestore(); }
  expect(deletes).toBe(10);
});

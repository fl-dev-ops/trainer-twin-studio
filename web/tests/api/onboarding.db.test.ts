import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as nextHeaders from "next/headers";
import * as workflow from "workflow/api";
import { auth } from "@/lib/auth";
import { ChromaTenantService } from "@/lib/chroma-tenant";
import { POST } from "@/app/api/onboarding/route";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { db, localMinutesDb, meteroidServer, minutesFixture, type MinutesFixture } from "../lib/minutes-test-db";
import { orgBillingService } from "../setup/org-billing";

// Real route, transaction, direct workflow fallback and billing helper; only request context and outside services fake.
describe.skipIf(!localMinutesDb)("onboarding route: setup and rollback", () => {
  const service = orgBillingService();
  const server = meteroidServer;
  let f: MinutesFixture;
  let token: string;
  let slug: string;
  let createdId: string | undefined;
  let headers: ReturnType<typeof spyOn<typeof nextHeaders, "headers">>;
  let session: ReturnType<typeof spyOn<typeof auth.api, "getSession">>;
  let active: ReturnType<typeof spyOn<typeof auth.api, "setActiveOrganization">>;
  let start: ReturnType<typeof spyOn<typeof workflow, "start">>;
  let createChroma: ReturnType<typeof spyOn<typeof ChromaTenantService, "createOrgDatabase">>;
  let deleteChroma: ReturnType<typeof spyOn<typeof ChromaTenantService, "deleteOrgDatabase">>;
  let log: ReturnType<typeof spyOn<typeof console, "error">>;
  beforeAll(() => { server.use(...service.handlers); });
  afterAll(() => { server.resetHandlers(); });
  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    token = randomUUID(); slug = `setup-${randomUUID().slice(0, 8)}`; createdId = undefined;
    await db.founderInvite.create({ data: { token, email: f.trainer.email } });
    service.requests.length = 0; service.grants.length = 0;
    headers = spyOn(nextHeaders, "headers").mockResolvedValue(new Headers({ host: `dash.${BASE_DOMAIN}:1355` }));
    session = spyOn(auth.api, "getSession").mockResolvedValue({ user: f.trainer } as never);
    active = spyOn(auth.api, "setActiveOrganization").mockResolvedValue({} as never);
    start = spyOn(workflow, "start").mockRejectedValue(new Error("workflow runtime not installed in tests"));
    createChroma = spyOn(ChromaTenantService, "createOrgDatabase").mockImplementation(async (id) => { createdId = id; return undefined as never; });
    deleteChroma = spyOn(ChromaTenantService, "deleteOrgDatabase").mockResolvedValue(undefined as never);
    log = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    for (const fn of [headers, session, active, start, createChroma, deleteChroma, log]) fn?.mockRestore();
    if (createdId) await db.organization.deleteMany({ where: { id: createdId } });
    await db.founderInvite.deleteMany({ where: { token } });
    await f.clean();
  });
  const post = () => POST(new Request("https://dash.test/api/onboarding", { method: "POST", body: JSON.stringify({ token, orgName: "New training", slug }) }));
  const invite = () => db.founderInvite.findUniqueOrThrow({ where: { token } });
  const writes = () => service.requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);

  test("success creates org/admin, provisions Chroma and OrgBilling, consumes invite and switches org", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ slug, redirect: `https://dash.${BASE_DOMAIN}:1355/` });
    const org = await db.organization.findUniqueOrThrow({ where: { slug }, include: { members: true, billing: true } });
    expect(org.members).toEqual([expect.objectContaining({ userId: f.trainer.id, role: "admin" })]);
    expect(org.billing).toMatchObject({ meteroidCustomerId: "customer-onboarding", balanceMinutes: 0 });
    expect(service.grants).toEqual([{ key: `trial-${org.id}`, body: { amount: 30, type: "PROMOTIONAL", reason: "Free trial", credit_unit: "MINS", expires_at: new Date(org.createdAt.getTime() + 30 * 86_400_000).toISOString() } }]);
    expect((await invite()).acceptedAt).not.toBeNull();
    expect(createChroma).toHaveBeenCalledTimes(1);
    expect(createChroma).toHaveBeenCalledWith(org.id);
    expect(active).toHaveBeenCalledWith({ headers: expect.any(Headers), body: { organizationId: org.id } });
    expect(deleteChroma).not.toHaveBeenCalled();
    expect(writes()).toEqual(["POST /customers", "POST /subscriptions", "POST /customers/customer-onboarding/credit-grants"]);
  });
  test("Chroma failure deletes org and resets invite before any billing setup", async () => {
    createChroma.mockImplementation(async (id) => { createdId = id; throw new Error("Chroma Cloud quota: 10 databases"); });
    expect((await post()).status).toBe(500);
    expect(await db.organization.findUnique({ where: { slug } })).toBeNull();
    expect((await invite()).acceptedAt).toBeNull();
    expect(deleteChroma).toHaveBeenCalledTimes(1);
    expect(deleteChroma).toHaveBeenCalledWith(createdId);
    expect(active).not.toHaveBeenCalled();
    expect(service.requests).toEqual([]);
  });
  test("failure after billing creation unlinks customer before deleting billing/org and resets invite", async () => {
    active.mockRejectedValue(new Error("session cookie failure"));
    expect((await post()).status).toBe(500);
    expect(await db.organization.findUnique({ where: { slug } })).toBeNull();
    expect(await db.orgBilling.findUnique({ where: { orgId: createdId! } })).toBeNull();
    expect((await invite()).acceptedAt).toBeNull();
    expect(deleteChroma).toHaveBeenCalledTimes(1);
    expect(deleteChroma).toHaveBeenCalledWith(createdId);
    expect(writes()).toEqual(["POST /customers", "POST /subscriptions", "POST /customers/customer-onboarding/credit-grants", "PATCH /customers/customer-onboarding", "DELETE /customers/customer-onboarding"]);
    expect(service.requests.find((r) => r.method === "PATCH")?.body).toEqual({ alias: "customer-onboarding-onboarding-failed" });
  });
  test("Chroma failure also unlinks a billing customer left by earlier setup work", async () => {
    createChroma.mockImplementation(async (id) => {
      createdId = id;
      await db.orgBilling.create({ data: { orgId: id, meteroidCustomerId: "earlier-customer" } });
      throw new Error("Chroma unavailable on replay");
    });
    expect((await post()).status).toBe(500);
    expect(await db.organization.findUnique({ where: { slug } })).toBeNull();
    expect((await invite()).acceptedAt).toBeNull();
    expect(writes()).toEqual(["PATCH /customers/earlier-customer", "DELETE /customers/earlier-customer"]);
  });
});

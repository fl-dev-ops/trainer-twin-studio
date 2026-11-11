import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as nextHeaders from "next/headers";
import * as workflow from "workflow/api";
import { auth } from "@/lib/auth";
import { ChromaTenantService } from "@/lib/chroma-tenant";
import { foundOrg } from "@/lib/onboarding";
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
  const post = (patch: Record<string, unknown> = {}) => POST(new Request("https://dash.test/api/onboarding", { method: "POST", body: JSON.stringify({ token, orgName: "New training", slug, ...patch }) }));
  const state = async () => [await db.organization.findMany({ where: { slug }, include: { members: true } }), await invite()];
  const refuses = async (response: Response, status: number, code: string, message: string) => {
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: message, code });
  };
  const invite = () => db.founderInvite.findUniqueOrThrow({ where: { token } });
  const writes = () => service.requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);

  test("success creates org/admin, provisions Chroma and OrgBilling, consumes invite and switches org", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ slug, redirect: `https://dash.${BASE_DOMAIN}:1355/` });
    const org = await db.organization.findUniqueOrThrow({ where: { slug }, include: { members: true, billing: true } });
    expect(org.members).toEqual([expect.objectContaining({ userId: f.trainer.id, role: "admin" })]);
    expect(org.billing).toMatchObject({ meteroidCustomerId: "customer-onboarding", balanceMinutes: 0 });
    expect(service.grants).toEqual([{ key: `trial-${org.id}-customer-onboarding`, body: { amount: 30, type: "PROMOTIONAL", reason: "Free trial", credit_unit: "MINS", expires_at: new Date(org.createdAt.getTime() + 30 * 86_400_000).toISOString() } }]);
    expect((await invite()).acceptedAt).not.toBeNull();
    expect(createChroma).toHaveBeenCalledTimes(1);
    expect(createChroma).toHaveBeenCalledWith(org.id);
    expect(active).toHaveBeenCalledWith({ headers: expect.any(Headers), body: { organizationId: org.id } });
    expect(deleteChroma).not.toHaveBeenCalled();
    expect(writes()).toEqual(["POST /customers", "POST /subscriptions", "POST /customers/customer-onboarding/credit-grants"]);
  });
  test("refuses onboarding_failed after Chroma failure, deleting org and restoring the token", async () => {
    createChroma.mockImplementation(async (id) => { createdId = id; throw new Error("Chroma Cloud quota: 10 databases"); });
    const before = await state();
    await refuses(await post(), 500, "onboarding_failed", "Could not create the organization. Try again.");
    expect(await state()).toEqual(before);
    expect(deleteChroma).toHaveBeenCalledTimes(1);
    expect(deleteChroma).toHaveBeenCalledWith(createdId);
    expect(active).not.toHaveBeenCalled();
    expect(service.requests).toEqual([]);
  });
  test("setActive failure after creation keeps org/admin/billing and the token spent", async () => {
    active.mockRejectedValue(new Error("session cookie failure"));
    expect((await post()).status).toBe(200);
    expect(await db.organization.findUnique({ where: { slug }, include: { members: true } })).toMatchObject({ members: [{ role: "admin", userId: f.trainer.id }] });
    expect(await db.orgBilling.findUnique({ where: { orgId: createdId! } })).not.toBeNull();
    expect((await invite()).acceptedAt).not.toBeNull();
    expect(deleteChroma).not.toHaveBeenCalled();
    expect(writes()).toEqual(["POST /customers", "POST /subscriptions", "POST /customers/customer-onboarding/credit-grants"]);
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
  test("refuses token_invalid for missing and spent founder tokens without writes", async () => {
    let before = await state();
    await refuses(await post({ token: "missing-founder-token" }), 400, "token_invalid", "This setup link is invalid or already used.");
    expect(await state()).toEqual(before);
    await db.founderInvite.update({ where: { token }, data: { acceptedAt: new Date() } });
    before = await state();
    await refuses(await post(), 400, "token_invalid", "This setup link is invalid or already used.");
    expect(await state()).toEqual(before);
    expect(createChroma).not.toHaveBeenCalled();
  });
  test("refuses token_email_mismatch without spending the token or creating the org", async () => {
    await db.founderInvite.update({ where: { token }, data: { email: "other@example.com" } });
    const before = await state();
    await refuses(await post(), 403, "token_email_mismatch", "This setup link is for a different email address.");
    expect(await state()).toEqual(before);
  });
  test.each(["a", "ab", "dash", "x".repeat(31), "-abc", "abc-"])("refuses slug_invalid for %s without spending the token", async (invalid) => {
    const before = await state();
    await refuses(await post({ slug: invalid }), 400, "slug_invalid", invalid === "dash" ? '"dash" is reserved' : "Use 3-30 lowercase letters, numbers or hyphens (no leading/trailing hyphen)");
    expect(await state()).toEqual(before);
  });
  test("refuses slug_taken without spending the founder token", async () => {
    await db.organization.update({ where: { id: f.org.id }, data: { slug } });
    const before = await state();
    await refuses(await post(), 409, "slug_taken", "That subdomain is taken.");
    expect(await state()).toEqual(before);
  });
  test("one founder token submitted concurrently makes exactly one org with one admin", async () => {
    const responses = await Promise.all([post(), post()]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    const refused = responses.find((response) => response.status !== 200)!;
    await refuses(refused, 400, "token_invalid", "This setup link is invalid or already used.");
    const orgs = await db.organization.findMany({ where: { slug }, include: { members: true } });
    expect(orgs).toHaveLength(1);
    expect(orgs[0].members).toHaveLength(1);
    expect(orgs[0].members[0].role).toBe("admin");
    expect(createChroma).toHaveBeenCalledTimes(1);
  });
  test("refuses token_invalid for empty/short tokens through the route and service without writes", async () => {
    const before = await state();
    for (const invalid of ["", "short"]) {
      await refuses(await post({ token: invalid }), 400, "token_invalid", "This setup link is invalid or already used.");
      await expect(foundOrg({ token: invalid, user: f.trainer, name: "Test", slug, websiteUrl: null })).rejects.toMatchObject({ code: "token_invalid", status: 400, message: "This setup link is invalid or already used." });
      expect(await state()).toEqual(before);
    }
    expect(service.requests).toEqual([]);
  });
  test("refuses token_email_mismatch and slug_invalid in the service with no writes", async () => {
    const before = await state(); const input = { token, user: f.learner, name: "Test", slug, websiteUrl: null };
    await expect(foundOrg(input)).rejects.toMatchObject({ code: "token_email_mismatch", status: 403, message: "This setup link is for a different email address." });
    await expect(foundOrg({ ...input, slug: "dash" })).rejects.toMatchObject({ code: "slug_invalid", status: 400, message: '"dash" is reserved' });
    expect(await state()).toEqual(before); expect(service.requests).toEqual([]);
  });
  test("refuses slug_taken for concurrent distinct founder tokens at the unique constraint, spending only the winner", async () => {
    const otherToken = randomUUID(); await db.founderInvite.create({ data: { token: otherToken, email: f.trainer.email } });
    try {
      const responses = await Promise.all([post(), post({ token: otherToken })]);
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      await refuses(responses.find((r) => r.status === 409)!, 409, "slug_taken", "That subdomain is taken.");
      const tokens = await db.founderInvite.findMany({ where: { token: { in: [token, otherToken] } } });
      expect(tokens.filter((t) => t.acceptedAt)).toHaveLength(1);
      expect(await db.organization.count({ where: { slug } })).toBe(1);
      expect(createChroma).toHaveBeenCalledTimes(1);
    } finally { await db.founderInvite.deleteMany({ where: { token: otherToken } }); }
  });
  test("refuses onboarding_failed for an unexpected transaction failure, leaving org and token unchanged", async () => {
    const before = await state();
    // A missing account violates the nested admin FK inside the actual founding transaction.
    const user = { ...f.trainer, id: "missing-founder-account" }; session.mockResolvedValue({ user } as never);
    await refuses(await post(), 500, "onboarding_failed", "Could not create the organization. Try again.");
    await expect(foundOrg({ token, user, name: "Test", slug, websiteUrl: null })).rejects.toMatchObject({ code: "onboarding_failed", status: 500, message: "Could not create the organization. Try again." });
    expect(await state()).toEqual(before); expect(createChroma).not.toHaveBeenCalled(); expect(service.requests).toEqual([]);
  });
  test("connector failure after founding keeps org, admin, billing and the spent token", async () => {
    const notion = await import("@/lib/org-knowledge"); const getKb = spyOn(notion, "getOrCreateOrgKnowledgeBase").mockRejectedValue(new Error("connector unavailable"));
    try {
      const response = await post({ knowledgeConnector: "notion" }); expect(response.status).toBe(200);
      expect((await response.json()).redirect).toContain("Workspace%20created");
      expect(await db.organization.findUniqueOrThrow({ where: { slug }, include: { members: true, billing: true } })).toMatchObject({ members: [{ role: "admin", userId: f.trainer.id }], billing: { meteroidCustomerId: "customer-onboarding" } });
      expect((await invite()).acceptedAt).not.toBeNull(); expect(deleteChroma).not.toHaveBeenCalled();
    } finally { getKb.mockRestore(); }
  });
  test("undo failure retains the half-created org and spent token for staff", async () => {
    createChroma.mockImplementation(async (id) => { createdId = id; throw new Error("setup failure"); });
    deleteChroma.mockRejectedValue(new Error("undo failure"));
    await refuses(await post(), 500, "onboarding_failed", "Could not create the organization. Try again.");
    expect(await db.organization.findUnique({ where: { slug } })).not.toBeNull();
    expect((await invite()).acceptedAt).not.toBeNull();
    await refuses(await post(), 409, "slug_taken", "That subdomain is taken.");
  });

});

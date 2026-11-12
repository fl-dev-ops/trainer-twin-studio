import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { http, HttpResponse } from "msw";
import { orgCredits, refreshOrgCredits, sendOrgUsage } from "@/lib/org-credits";
import { grantMinutes, learnerBalance, recordSessionUsage } from "@/lib/minutes";
import { minutesRouter } from "@/lib/minutes-trpc";
import { POST } from "@/app/api/meteroid/webhook/route";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";
import { fundOrg, grants, usageEvents, wallets } from "../setup/meteroid";
import { outsideServices } from "../flows/harness";

const syncs: string[] = [];
const reports: string[] = [];
mock.module("@/lib/schedule-org-credits", () => ({ scheduleOrgSync: async (id: string) => { syncs.push(id); }, scheduleOrgUsage: async (id: string) => { reports.push(id); } }));

describe.skipIf(!localMinutesDb)("org credits from Meteroid", () => {
  let f: MinutesFixture;
  const outside = outsideServices();
  const customer = () => `customer_${f.org.id}`;
  const api = () => minutesRouter.createCaller({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" } });
  beforeEach(async () => { outside.start(); f = minutesFixture(); await f.create(); syncs.length = reports.length = usageEvents.length = 0; });
  afterEach(async () => { await f.clean(); outside.stop(); expect(outside.unexpected).toEqual([]); outside.reset(); outside.resetHandlers(); });

  test("unbilled org has zero credits and cannot grant", async () => {
    expect(await orgCredits(f.org.id, { fresh: true })).toEqual({ billed: false, seconds: 0, minutes: 0 });
    await expect(grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 1 })).rejects.toMatchObject({ status: 409 });
  });

  test("subtract unsent, equal/after-as_of spending and capped running staff calls, but not counted rows or learner usage", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    const asOf = new Date("2026-01-02");
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { balanceAsOf: asOf } });
    const staff = await f.session({ userId: f.trainer.id, chargesOrg: true });
    const learner = await f.session();
    await db.minuteLedger.createMany({ data: [
      { orgId: f.org.id, email: f.learner.email, type: "grant", seconds: 600 },
      { orgId: f.org.id, email: f.learner.email, type: "grant", seconds: 120, meteroidSentAt: asOf },
      { orgId: f.org.id, email: f.trainer.email, type: "org_usage", seconds: -90, sessionId: staff.id, meteroidSentAt: new Date("2026-01-03") },
      { orgId: f.org.id, email: f.learner.email, type: "grant", seconds: 1200, meteroidSentAt: new Date("2026-01-01") },
      { orgId: f.org.id, email: f.learner.email, type: "usage", seconds: -300, sessionId: learner.id },
    ] });
    await f.session({ chargesOrg: true, userId: f.trainer.id, status: "active", endedAt: null, startedAt: new Date(Date.now() - 600_000), allowedSeconds: 60 });
    await f.session({ chargesOrg: true, status: "failed", endedAt: null });
    expect(await orgCredits(f.org.id)).toEqual({ billed: true, seconds: 6000 - 600 - 120 - 90 - 60, minutes: 85 });
    expect((await learnerBalance(f.org.id, f.trainer.email)).usedSeconds).toBe(0);
  });

  test.each(["http", "network"])("fresh balance falls back to the cached copy on %s failure, minus pending spending", async (failure) => {
    await fundOrg({ orgId: f.org.id, minutes: 10 });
    await db.minuteLedger.create({ data: { orgId: f.org.id, email: f.learner.email, type: "grant", seconds: 120 } });
    outside.use(http.get("https://meteroid.test/api/v1/customers/:id/wallets/check", () => failure === "http" ? new HttpResponse(null, { status: 503 }) : HttpResponse.error()));
    expect(await orgCredits(f.org.id, { fresh: true })).toEqual({ billed: true, seconds: 480, minutes: 8 });
    await expect(grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 9 })).rejects.toMatchObject({ status: 409 });
    expect(reports).toEqual([]);
  });

  test("fresh balance times out and falls back without dropping pending spending", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 10 });
    await db.minuteLedger.create({ data: { orgId: f.org.id, email: f.learner.email, type: "grant", seconds: 60 } });
    outside.use(http.get("https://meteroid.test/api/v1/customers/:id/wallets/check", async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return HttpResponse.json({ balance: 999, as_of: new Date().toISOString() });
    }));
    expect(await orgCredits(f.org.id, { fresh: true })).toEqual({ billed: true, seconds: 540, minutes: 9 });
  });

  test("fresh reads store live balance/as_of; cached reads do not fetch", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 10 });
    wallets.set(customer(), { balance: 25, as_of: "2026-01-02T00:00:00.000Z" });
    expect((await orgCredits(f.org.id)).minutes).toBe(10);
    expect((await orgCredits(f.org.id, { fresh: true })).minutes).toBe(25);
    expect(await db.orgBilling.findUniqueOrThrow({ where: { orgId: f.org.id } })).toMatchObject({ balanceMinutes: 25, balanceAsOf: new Date("2026-01-02") });
  });

  test.each([
    ["expired after as_of", "2020-01-03T00:00:00Z", 6, true],
    ["expired before as_of", "2020-01-01T00:00:00Z", 10, false],
    ["expired at as_of", "2020-01-02T00:00:00Z", 10, false],
    ["not expired", "2099-01-01T00:00:00Z", 10, false],
    ["no expiry", null, 10, false],
  ] as const)("cached org credits: %s", async (_label, expiresAt, minutes, scheduled) => {
    await fundOrg({ orgId: f.org.id, minutes: 10 });
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: {
      balanceAsOf: new Date("2020-01-02"),
      grants: [{ id: "trial", minutes: 4, expiresAt, reason: "Trial", status: "ACTIVE", createdAt: null }],
    } });
    outside.use(http.get("https://meteroid.test/api/v1/customers/:id/wallets/check", () => {
      throw new Error("cached reads must not fetch Meteroid");
    }));
    expect(await orgCredits(f.org.id)).toEqual({ billed: true, seconds: minutes * 60, minutes });
    expect(syncs).toEqual(scheduled ? [f.org.id] : []);
  });

  test("recordSessionUsage chooses org_usage or usage once, caps seconds and schedules only staff spending", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 10 });
    for (const chargesOrg of [true, false]) {
      const session = await f.session({ chargesOrg, userId: chargesOrg ? f.trainer.id : f.learner.id, allowedSeconds: 45 });
      await Promise.all([recordSessionUsage(session.id), recordSessionUsage(session.id)]);
      expect(await db.minuteLedger.findMany({ where: { sessionId: session.id }, select: { type: true, seconds: true, email: true } })).toEqual([{ type: chargesOrg ? "org_usage" : "usage", seconds: -45, email: chargesOrg ? f.trainer.email : f.learner.email }]);
    }
    expect(reports).toEqual([f.org.id]);
  });

  test("sendOrgUsage sends unsent spending with row IDs and seconds/60, marks only successful sends and is repeatable", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 10 });
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 2 });
    const session = await f.session({ chargesOrg: true, userId: f.trainer.id, allowedSeconds: 45 }); await recordSessionUsage(session.id);
    const rows = await db.minuteLedger.findMany({ where: { orgId: f.org.id }, orderBy: { createdAt: "asc" } });
    outside.use(http.post("https://meteroid.test/api/v1/events/ingest", () => new HttpResponse(null, { status: 503 })));
    await expect(sendOrgUsage(f.org.id)).rejects.toThrow("503");
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, meteroidSentAt: null } })).toBe(2);
    outside.resetHandlers();
    const sentAt = await sendOrgUsage(f.org.id);
    expect(sentAt).toBeInstanceOf(Date);
    expect(usageEvents).toEqual(rows.map((r) => ({ event_id: r.id, code: "voice_minutes", customer_id: customer(), timestamp: r.createdAt.toISOString(), properties: { minutes: r.type === "grant" ? "2" : "0.75", kind: r.type === "grant" ? "given_to_learner" : "staff_call", email: r.email, ...(r.sessionId ? { session: r.sessionId } : {}) } })));
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, meteroidSentAt: sentAt! } })).toBe(2);
    expect(await sendOrgUsage(f.org.id)).toBeNull();
    expect(await sendOrgUsage("unknown")).toBeNull();
    expect(usageEvents).toHaveLength(2);
  });

  test("refresh stores grants/balance/as_of, filters other units, and counted requires strictly later as_of", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 10 });
    const at = new Date("2026-01-02");
    wallets.set(customer(), { balance: 7, as_of: at.toISOString() });
    grants.set(customer(), [
      { id: "grant", amount: 10, credit_unit: "MINS", reason: "Credit purchased on a paid invoice", source: "PURCHASE", expires_at: "2027-01-02T00:00:00Z", status: "ACTIVE", created_at: "2026-01-01T00:00:00Z" },
      { id: "other", amount: 99, credit_unit: "OTHER" },
    ]);
    expect(await refreshOrgCredits(f.org.id, at)).toEqual({ counted: false });
    expect(await refreshOrgCredits(f.org.id, new Date(at.getTime() + 1))).toEqual({ counted: false });
    expect(await refreshOrgCredits(f.org.id, new Date(at.getTime() - 1))).toEqual({ counted: true });
    const billing = await db.orgBilling.findUniqueOrThrow({ where: { orgId: f.org.id } });
    expect(billing).toMatchObject({ balanceMinutes: 7, balanceAsOf: at, syncedAt: expect.any(Date), grants: [{ id: "grant", minutes: 10, reason: "Credit purchased on a paid invoice", source: "PURCHASE", expiresAt: "2027-01-02T00:00:00Z", status: "ACTIVE", createdAt: "2026-01-01T00:00:00Z" }] });
    expect(await api().org()).toMatchObject({ billed: true, balanceMinutes: 7, addedMinutes: 10, grants: [{ id: "grant", minutes: 10, note: "Minute pack", expiresAt: "2027-01-02T00:00:00Z", expired: false, by: null }] });
    expect(await refreshOrgCredits("unknown", at)).toEqual({ counted: true });
  });

  test.each([
    ["new grant catches up on first re-read", "2020-01-03T00:00:00Z", 2, 2],
    ["new grant needs two re-reads", "2020-01-03T00:00:00Z", 3, 3],
    ["grant predates as_of", "2020-01-01T00:00:00Z", null, 1],
    ["grant equals as_of", "2020-01-02T00:00:00Z", null, 1],
    ["grant has no creation time", null, null, 1],
    ["new grant never catches up", "2020-01-03T00:00:00Z", null, 6],
  ] as const)("refresh funded wallet: %s", async (_label, createdAt, catchUpOn, expectedReads) => {
    await fundOrg({ orgId: f.org.id, minutes: 10 });
    grants.set(customer(), [{ id: "funded", amount: 20, credit_unit: "MINS", status: "ACTIVE", created_at: createdAt }]);
    let reads = 0;
    outside.use(http.get("https://meteroid.test/api/v1/customers/:id/wallets/check", () => {
      reads++;
      return HttpResponse.json({ balance: 10 + reads, as_of: catchUpOn && reads >= catchUpOn ? "2020-01-04T00:00:00Z" : "2020-01-02T00:00:00Z" });
    }));
    // Only skip the recount sleep; leave database and MSW timers alone.
    const timeout = globalThis.setTimeout;
    const waits: number[] = [];
    const timer = spyOn(globalThis, "setTimeout").mockImplementation((...args: Parameters<typeof setTimeout>) => {
      if (args[1] === 2000) { waits.push(args[1]); args[1] = 0; }
      return timeout(...args);
    });
    try {
      await refreshOrgCredits(f.org.id);
      expect(reads).toBe(expectedReads);
      expect(waits).toEqual(Array(expectedReads - 1).fill(2000));
      expect(usageEvents).toEqual([]);
      expect(await db.orgBilling.findUniqueOrThrow({ where: { orgId: f.org.id } })).toMatchObject({
        balanceMinutes: 10 + expectedReads,
        balanceAsOf: new Date(catchUpOn ? "2020-01-04" : "2020-01-02"),
        grants: [{ id: "funded", minutes: 20, status: "ACTIVE", createdAt, reason: null, expiresAt: null }],
        syncedAt: expect.any(Date),
      });
    } finally {
      timer.mockRestore();
    }
  });

  test.each([["completed", true], ["exhausted", false]] as const)("refresh expiry recount %s: zero-minute events, bounded re-reads and safe cached balance", async (_label, recounts) => {
    await fundOrg({ orgId: f.org.id, minutes: 20 });
    const expired = [
      { id: "trial-a", amount: 4, expires_at: "2020-01-02T00:00:00Z" },
      { id: "trial-b", amount: 6, expires_at: "2020-01-03T00:00:00Z" },
    ];
    grants.set(customer(), [
      ...expired.map((grant) => ({ ...grant, credit_unit: "MINS", status: "EXPIRED" })),
      { id: "already-counted", amount: 7, expires_at: "2019-12-31T00:00:00Z", credit_unit: "MINS" },
      { id: "future", amount: 10, expires_at: "2099-01-01T00:00:00Z", credit_unit: "MINS" },
    ]);
    let reads = 0;
    outside.use(http.get("https://meteroid.test/api/v1/customers/:id/wallets/check", () => {
      reads++;
      const wallet = recounts && usageEvents.length
        ? reads === 2
          ? { balance: 16, as_of: "2020-01-02T00:00:00Z" }
          : { balance: 10, as_of: "2020-01-04T00:00:00Z" }
        : { balance: 20, as_of: "2020-01-01T00:00:00Z" };
      return HttpResponse.json(wallet);
    }));
    // Only fake the recount delay: Prisma and MSW keep their real timers.
    const timeout = globalThis.setTimeout;
    const waits: number[] = [];
    const timer = spyOn(globalThis, "setTimeout").mockImplementation((...args: Parameters<typeof setTimeout>) => {
      if (args[1] === 2000) { waits.push(args[1]); args[1] = 0; }
      return timeout(...args);
    });
    try {
      expect(await refreshOrgCredits(f.org.id)).toEqual({ counted: true });
      expect(usageEvents).toEqual(expired.map((grant) => ({
        event_id: `expired-${grant.id}`, customer_id: customer(), code: "voice_minutes", timestamp: expect.any(String),
        properties: { minutes: "0", kind: "recount_after_expiry", grant: grant.id },
      })));
      expect(reads).toBe(recounts ? 3 : 6);
      expect(waits).toEqual(Array(recounts ? 2 : 5).fill(2000));
      expect(await db.orgBilling.findUniqueOrThrow({ where: { orgId: f.org.id } })).toMatchObject({
        balanceMinutes: recounts ? 10 : 20,
        balanceAsOf: new Date(recounts ? "2020-01-04" : "2020-01-01"),
        syncedAt: expect.any(Date), grants: expect.arrayContaining(expired.map((grant) => ({
          id: grant.id, minutes: grant.amount, expiresAt: grant.expires_at, reason: null, status: "EXPIRED", createdAt: null, source: null,
        }))),
      });
      expect(await orgCredits(f.org.id)).toEqual({ billed: true, seconds: 600, minutes: 10 });
      expect(syncs).toEqual(recounts ? [] : [f.org.id]);
      if (recounts) {
        await refreshOrgCredits(f.org.id);
        await refreshOrgCredits(f.org.id);
        expect(usageEvents).toHaveLength(2);
        expect(reads).toBe(5);
        expect(waits).toHaveLength(2);
      }
    } finally {
      timer.mockRestore();
    }
  });

  test("minutes.org refreshes stale copies and schedules unsent usage; expired grants stay in history", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 10 });
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { syncedAt: new Date(0) } });
    wallets.set(customer(), { balance: 10, as_of: "2026-01-03T00:00:00.000Z" });
    await db.minuteLedger.create({ data: { orgId: f.org.id, type: "grant", seconds: 60, email: f.learner.email } });
    grants.set(customer(), [{ id: "expired", amount: 10, credit_unit: "MINS", status: "EXPIRED", reason: "Trial", expires_at: "2026-01-02T00:00:00Z" }]);
    expect(await api().org()).toMatchObject({ balanceMinutes: 9, grants: [{ note: "From TrainerTwin", expired: true }] });
    expect(reports).toEqual([f.org.id]);
  });

  async function version() {
    const requests: string[] = [];
    outside.use(http.all("https://meteroid.test/*", ({ request }) => {
      requests.push(`${request.method} ${request.url}`);
      return new HttpResponse(null, { status: 500 });
    }));
    try {
      const value = await api().version();
      expect(typeof value).toBe("string");
      expect(requests).toEqual([]);
      return value;
    } finally {
      outside.resetHandlers();
    }
  }

  test("minutes.version is stable without billing or ledger, and changes with cached balance and grant status without Meteroid", async () => {
    const empty = await version();
    expect(await version()).toBe(empty);
    await fundOrg({ orgId: f.org.id, minutes: 10 });
    const funded = await version();
    expect(funded).not.toBe(empty);
    expect(await version()).toBe(funded);
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { balanceMinutes: 20 } });
    const changedBalance = await version();
    expect(changedBalance).not.toBe(funded);
    const billing = await db.orgBilling.findUniqueOrThrow({ where: { orgId: f.org.id } });
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { grants: (billing.grants as { id: string; status: string }[]).map((grant) => ({ ...grant, status: "EXPIRED" })) } });
    const changedStatus = await version();
    expect(changedStatus).not.toBe(changedBalance);
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { syncedAt: new Date(0) } });
    expect(await version()).toBe(changedStatus);
  });

  test("minutes.version changes after giving learner credits and staff usage, and tracks the newest ledger row", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 10 });
    const initial = await version();
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 2 });
    const given = await version();
    expect(given).not.toBe(initial);
    expect(await version()).toBe(given);
    await db.minuteLedger.updateMany({ where: { orgId: f.org.id }, data: { createdAt: new Date("2020-01-01") } });
    const session = await f.session({ chargesOrg: true, userId: f.trainer.id });
    await recordSessionUsage(session.id);
    expect(await db.minuteLedger.findUniqueOrThrow({ where: { sessionId: session.id } })).toMatchObject({ type: "org_usage" });
    const used = await version();
    expect(used).not.toBe(given);
    await db.minuteLedger.create({ data: { orgId: f.org.id, email: f.learner.email, type: "grant", seconds: 60, createdAt: new Date("2019-01-01") } });
    expect(await version()).toBe(used);
  });

  async function webhook(event: unknown, delta = 0, bad = false) {
    const body = JSON.stringify(event), id = "msg_test", timestamp = String(Math.floor(Date.now() / 1000) + delta);
    const key = Buffer.from(process.env.METEROID_WEBHOOK_SECRET!.replace(/^whsec_/, ""), "base64");
    const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
    return POST(new Request("http://dash.test/api/meteroid/webhook", { method: "POST", body, headers: { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": bad ? "v1,wrong" : `v1,${signature}` } }));
  }
  test.each(["wallet.funded", "wallet.debited", "wallet.depleted", "wallet.recovered", "credit_grant.expired"])("signed %s webhook schedules org sync (top-level and nested customer)", async (type) => {
    await fundOrg({ orgId: f.org.id, minutes: 10 });
    for (const event of [{ type, customer_id: customer() }, { type, data: { customer_id: customer() } }]) expect(await (await webhook(event)).json()).toEqual({ ok: true, synced: f.org.id });
    expect(syncs).toEqual([f.org.id, f.org.id]);
  });
  test("webhook rejects bad/old signatures and ignores unrelated events or unknown customers", async () => {
    expect((await webhook({ type: "wallet.funded" }, 0, true)).status).toBe(401);
    expect((await webhook({ type: "wallet.funded" }, -301)).status).toBe(401);
    expect(await (await webhook({ type: "customer.created" })).json()).toEqual({ ok: true, ignored: "customer.created" });
    expect(await (await webhook({ type: "wallet.funded", customer_id: "unknown" })).json()).toEqual({ ok: true, ignored: "not an org" });
    expect(syncs).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import * as database from "@/lib/db";
import * as jev from "@/lib/jev";
import * as ending from "@/lib/session-end";
import { activateSession } from "@/lib/interview-sessions";
import { twinRouter } from "@/lib/twin/trpc";
import { scoreCalibrationOnce } from "@/lib/twin/calibration-score";
import { readCalibration, scoreCalibration } from "@/workflows/steps/calibration";
import { endTwinSession } from "@/workflows/end-twin-session";
import { fundOrg } from "../setup/meteroid";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

// Real PostgreSQL rows, locks and claims; only the chat/model and end dispatch transports are faked.
describe.skipIf(!localMinutesDb)("Module 3 calibration (real PostgreSQL)", () => {
  let f: MinutesFixture;
  let secret: string | undefined;
  let model: ReturnType<typeof spyOn<typeof jev, "decide">>;
  let chat: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
  const spies: { mockRestore(): void }[] = [];
  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    secret = process.env.COPILOT_SERVICE_SECRET; process.env.COPILOT_SERVICE_SECRET = "calibration-test-secret";
    model = spyOn(jev, "decide").mockResolvedValue({});
    const fetch = globalThis.fetch;
    chat = spyOn(globalThis, "fetch").mockImplementation((url, init) => String(url).includes("meteroid.test") ? fetch(url, init) : Promise.resolve(new Response(null, { status: 204 })));
    spies.push(model, chat, spyOn(ending, "startSessionEnd").mockResolvedValue(undefined));
  });
  afterEach(async () => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
    if (secret === undefined) delete process.env.COPILOT_SERVICE_SECRET; else process.env.COPILOT_SERVICE_SECRET = secret;
    await f.clean();
  });
  const caller = (id = f.trainer.id, orgId = f.org.id) => twinRouter.createCaller({ user: { ...f.trainer, id, orgId, orgSlug: f.org.slug, role: "admin" } });
  const start = (userId = f.trainer.id, agentSlug = f.twin.slug) => activateSession({ orgId: f.org.id, userId, agentSlug, mode: "voice", calibrate: true });
  const rows = async () => ({
    sessions: await db.interviewSession.count({ where: { orgId: f.org.id } }),
    calibrations: await db.twinCalibration.count({ where: { session: { orgId: f.org.id } } }),
    ratings: await db.twinCalibrationRating.count({ where: { calibration: { session: { orgId: f.org.id } } } }),
  });
  const calibration = async (fields: Parameters<MinutesFixture["session"]>[0] = {}) => {
    const session = await f.session({ agentId: f.twin.id, agentSlug: f.twin.slug, userId: f.trainer.id, allowedSeconds: null,
      status: "active", endedAt: null, transcript: [{ role: "user", text: "When should I follow up?" }, { role: "trainer", text: "This evening." }], ...fields });
    const record = await db.twinCalibration.create({ data: { sessionId: session.id, createdByUserId: f.trainer.id } });
    return { session, record };
  };
  const rating = (calibrationId: string) => ({ calibrationId, turnIndex: 1, question: "When should I follow up?", reply: "This evening.", rating: "like" as const });
  const saved = (id: string) => db.twinCalibration.findUniqueOrThrow({ where: { id } });
  const rateHttp = (input: unknown) => fetchRequestHandler({
    endpoint: "/trpc", router: twinRouter,
    createContext: () => ({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" } }),
    req: new Request("https://test/trpc/calibrations.rate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ json: input }) }),
  });

  test.each(["admin", "team"])("%s calibrate:true creates its call and calibration before chat setup and returns calibrationId", async (role) => {
    if (role === "team") await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { role } });
    const userId = role === "admin" ? f.trainer.id : f.learner.id;
    chat.mockImplementation(async () => {
      // A separate connection must see both committed rows, with the creator equal to the call's owner.
      const records = await db.twinCalibration.findMany({ where: { session: { orgId: f.org.id } }, include: { session: true } });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ createdByUserId: userId, session: { userId, agentId: f.twin.id, status: "activating" } });
      return new Response(null, { status: 204 });
    });
    const session = await start(userId);
    expect(session).toMatchObject({ status: "active", secondsLeft: null });
    expect(typeof session?.calibrationId).toBe("string");
    expect(session!.calibrationId!.length).toBeGreaterThan(0);
    expect(await saved(session!.calibrationId!)).toMatchObject({ sessionId: session!.id, createdByUserId: userId, scoredAt: null });
    expect(await rows()).toEqual({ sessions: 1, calibrations: 1, ratings: 0 });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  test("calibration insertion failure rolls back the new call and the replaced call's end in the same locked transaction", async () => {
    const old = await f.session({ agentId: f.twin.id, agentSlug: f.twin.slug, userId: f.trainer.id, status: "active", endedAt: null, allowedSeconds: null });
    const lock = database.withLock;
    const failure = new Error("calibration insert failed");
    spies.push(spyOn(database, "withLock").mockImplementation(<T,>(keys: string[], work: (tx: Parameters<Parameters<typeof lock>[1]>[0]) => Promise<T>, options?: { timeout?: number; maxWait?: number }) => lock(keys, async (tx) => {
      // Prisma transaction delegates are recreated on access; replace just this insert, not the transaction.
      return work(new Proxy(tx, { get(target, key) {
        return key === "twinCalibration" ? { ...target.twinCalibration, create: async () => { throw failure; } } : Reflect.get(target, key);
      } }));
    }, options)));
    await expect(start()).rejects.toBe(failure);
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: old.id } })).toEqual(old);
    expect(await rows()).toEqual({ sessions: 1, calibrations: 0, ratings: 0 });
    expect(chat).not.toHaveBeenCalled();
  });

  test("refuses studio_only for a learner's calibrate:true with no call or calibration written", async () => {
    await db.twinAssignment.create({ data: { orgId: f.org.id, agentId: f.twin.id, userId: f.learner.id, minutesLimit: 30, shareCode: `${f.org.id}-personal` } });
    await expect(start(f.learner.id)).rejects.toMatchObject({ code: "studio_only", status: 403, message: "Only the organization's admin and team can do this." });
    expect(await rows()).toEqual({ sessions: 0, calibrations: 0, ratings: 0 });
    expect(chat).not.toHaveBeenCalled();
  });
  test("refuses studio_only for a learner asking to calibrate, before any twin access check", async () => {
    const error = await start(f.learner.id).catch((error: unknown) => error);
    expect(await rows()).toEqual({ sessions: 0, calibrations: 0, ratings: 0 });
    expect(error).toMatchObject({ code: "studio_only", status: 403, message: "Only the organization's admin and team can do this." });
  });
  test("refuses not_found for a studio calibration on a role play with no call or calibration written", async () => {
    await expect(start(f.trainer.id, f.roleplay.slug)).rejects.toMatchObject({ code: "not_found", status: 404, message: "Not found." });
    expect(await rows()).toEqual({ sessions: 0, calibrations: 0, ratings: 0 });
  });
  test.each([
    ["org_paused", 10, "Your organization's plan is paused because an invoice is overdue. Pay it to continue (Settings › Billing)."],
    ["org_credits_out", 0, "Your organization has no credits left. Contact TrainerTwin to add more."],
    ["org_credits_short", 4, "Your organization needs at least 5 credits to start a call; it has 4. Contact TrainerTwin to add more."],
  ] as const)("refuses org_paused, refuses org_credits_out and refuses org_credits_short without a calibration (%s)", async (code, minutes, message) => {
    await fundOrg({ orgId: f.org.id, minutes });
    if (code === "org_paused") await db.orgBilling.update({ where: { orgId: f.org.id }, data: { plan: "paid", paidSubscriptionId: `paid-${f.org.id}`, pausedAt: new Date() } });
    await expect(start()).rejects.toMatchObject({ code, status: 403, message });
    expect(await rows()).toEqual({ sessions: 0, calibrations: 0, ratings: 0 });
    expect(chat.mock.calls.filter(([url]) => !String(url).includes("meteroid.test"))).toHaveLength(0);
  });

  test.each(["activating", "active"])("creator can rate while %s and re-rating replaces the same turn", async (status) => {
    const { record } = await calibration({ status });
    expect(await caller().calibrations.rate(rating(record.id))).toEqual({ ok: true });
    const first = await db.twinCalibrationRating.findFirstOrThrow({ where: { calibrationId: record.id } });
    expect(await caller().calibrations.rate({ ...rating(record.id), question: null, reply: "Ask what they need.", rating: "off" })).toEqual({ ok: true });
    expect(await db.twinCalibrationRating.findMany({ where: { calibrationId: record.id } })).toEqual([expect.objectContaining({ id: first.id, turnIndex: 1, question: null, reply: "Ask what they need.", rating: "off" })]);
  });
  test.each(["other-user", "other-org", "deleted", "archived"] as const)("rate refuses not_found for %s without writing ratings", async (state) => {
    const { record, session } = await calibration();
    if (state === "deleted") await db.interviewSession.update({ where: { id: session.id }, data: { deletedAt: new Date() } });
    if (state === "archived") await db.agent.update({ where: { id: f.twin.id }, data: { archivedAt: new Date() } });
    const c = caller(state === "other-user" ? f.learner.id : f.trainer.id, state === "other-org" ? "another-org" : f.org.id);
    await expect(c.calibrations.rate(rating(record.id))).rejects.toMatchObject({ code: "NOT_FOUND", message: "Not found.", cause: { code: "not_found", status: 404 } });
    expect((await rows()).ratings).toBe(0);
  });
  test.each(["completed", "abandoned", "failed", "revoked"])("refuses calibration_ended 409 for an ended, even unscored, call (%s)", async (status) => {
    const { record } = await calibration({ status, endedAt: new Date() });
    await expect(caller().calibrations.rate(rating(record.id))).rejects.toMatchObject({ code: "CONFLICT", message: "This calibration call has ended.", cause: { code: "calibration_ended", status: 409 } });
    const response = await rateHttp(rating(record.id));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { json: { message: "This calibration call has ended.", data: { code: "CONFLICT", refusal: "calibration_ended", httpStatus: 409 } } } });
    expect((await saved(record.id)).scoredAt).toBeNull();
    expect((await rows()).ratings).toBe(0);
  });
  test.each([
    { name: "negative turn", invalid: { turnIndex: -1 } }, { name: "fractional turn", invalid: { turnIndex: 0.5 } },
    { name: "reply over 8000 characters", invalid: { reply: "x".repeat(8001) } },
    { name: "unknown rating", invalid: { rating: "bad" } }, { name: "empty calibration id", invalid: { calibrationId: "" } },
  ])("refuses invalid_input on bad calibration rating ($name)", async ({ invalid }) => {
    const { record } = await calibration();
    const response = await rateHttp({ ...rating(record.id), ...invalid });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { json: { data: { code: "BAD_REQUEST", refusal: "invalid_input", httpStatus: 400 } } } });
    expect((await rows()).ratings).toBe(0);
  });
  test("rate accepts turn zero and the 8000-character reply boundary", async () => {
    const { record } = await calibration();
    await caller().calibrations.rate({ ...rating(record.id), turnIndex: 0, reply: "x".repeat(8000) });
    expect(await db.twinCalibrationRating.findFirstOrThrow({ where: { calibrationId: record.id } })).toMatchObject({ turnIndex: 0, reply: "x".repeat(8000) });
  });
  test.each(["deleted", "archived", "other-org"] as const)("get refuses not_found for %s", async (state) => {
    const { record, session } = await calibration();
    if (state === "deleted") await db.interviewSession.update({ where: { id: session.id }, data: { deletedAt: new Date() } });
    if (state === "archived") await db.agent.update({ where: { id: f.twin.id }, data: { archivedAt: new Date() } });
    await expect(caller(f.trainer.id, state === "other-org" ? "another-org" : f.org.id).calibrations.get({ id: record.id })).rejects.toMatchObject({ code: "NOT_FOUND", cause: { code: "not_found", status: 404 } });
  });
  test("list shows the 100 newest calibrations only, excludes deleted calls, and hides archived twins", async () => {
    const records: string[] = [];
    for (let i = 0; i < 102; i++) {
      const { record } = await calibration({ status: "completed", endedAt: new Date(), deletedAt: i === 101 ? new Date() : null });
      await db.twinCalibration.update({ where: { id: record.id }, data: { createdAt: new Date(Date.UTC(2026, 10, 15, 0, 0, i)) } });
      records.push(record.id);
    }
    const result = await caller().calibrations.list({ slug: f.twin.slug });
    expect(result.calibrations.map((row) => row.id)).toEqual(records.slice(1, 101).reverse());
    await db.agent.update({ where: { id: f.twin.id }, data: { archivedAt: new Date() } });
    await expect(caller().calibrations.list({ slug: f.twin.slug })).rejects.toMatchObject({ code: "NOT_FOUND", cause: { code: "not_found", status: 404 } });
  });
  test("get shows raw counts before scoring and saved model counts after scoring to another studio member", async () => {
    const { record, session } = await calibration();
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { role: "team" } });
    await caller().calibrations.rate({ ...rating(record.id), rating: "off" });
    expect(await caller(f.learner.id).calibrations.get({ id: record.id })).toMatchObject({ sessionId: session.id, score: { turns: 1, off: 1 } });
    model.mockResolvedValue({ "turn-0": { probabilities: { noise: 1 } }, "off-1": { probabilities: { mistake: 1 } } });
    await scoreCalibrationOnce(session.id);
    expect(await caller(f.learner.id).calibrations.get({ id: record.id })).toMatchObject({ score: { turns: 0, off: 0 } });
  });

  test("scoreCalibrationOnce concurrent calls claim once: only the winner calls decide", async () => {
    const { record, session } = await calibration({ status: "completed", endedAt: new Date() });
    let entered!: () => void; const deciding = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const hold = new Promise<void>((resolve) => { release = resolve; });
    model.mockImplementation(async () => { entered(); await hold; return {}; });
    const winner = scoreCalibrationOnce(session.id);
    try {
      await deciding;
      expect(await scoreCalibrationOnce(session.id)).toBeNull();
      expect(model).toHaveBeenCalledTimes(1);
    } finally { release(); }
    expect(await winner).toEqual({ turns: 1, off: 0 });
    expect(await saved(record.id)).toMatchObject({ turns: 1, offTurns: 0, scoredAt: expect.any(Date) });
  });
  test("scoreCalibrationOnce never calls decide for a scored calibration", async () => {
    const { record, session } = await calibration();
    const scoredAt = new Date();
    await db.twinCalibration.update({ where: { id: record.id }, data: { scoredAt, turns: 7, offTurns: 2 } });
    expect(await scoreCalibrationOnce(session.id)).toBeNull();
    expect(model).not.toHaveBeenCalled();
    expect(await saved(record.id)).toMatchObject({ scoredAt, turns: 7, offTurns: 2 });
  });
  test("scoreCalibrationOnce takes over a stale claim older than two minutes", async () => {
    const { record, session } = await calibration();
    const stale = new Date(Date.now() - 121_000);
    await db.twinCalibration.update({ where: { id: record.id }, data: { scoreClaimedAt: stale } });
    expect(await scoreCalibrationOnce(session.id)).toEqual({ turns: 1, off: 0 });
    expect(model).toHaveBeenCalledTimes(1);
    const row = await saved(record.id);
    expect(row.scoredAt).toBeInstanceOf(Date);
    expect(row.scoreClaimedAt!.getTime()).toBeGreaterThan(stale.getTime());
  });
  test("scoreCalibrationOnce failure clears its claim, throws, and a later call scores with the saved ratings", async () => {
    const { record, session } = await calibration();
    await caller().calibrations.rate({ ...rating(record.id), rating: "off" });
    const failure = new Error("model unavailable");
    model.mockRejectedValueOnce(failure);
    await expect(scoreCalibrationOnce(session.id)).rejects.toBe(failure);
    expect(await saved(record.id)).toMatchObject({ scoreClaimedAt: null, scoredAt: null, turns: null, offTurns: null });
    expect(await scoreCalibrationOnce(session.id)).toEqual({ turns: 1, off: 1 });
    expect(model).toHaveBeenCalledTimes(2);
    expect(await saved(record.id)).toMatchObject({ scoredAt: expect.any(Date), turns: 1, offTurns: 1 });
    expect(model.mock.calls[1][1]).toHaveProperty("off-1");
  });
  test.each([
    { name: "empty", transcript: [] },
    { name: "twin greeting only", transcript: [{ role: "trainer", text: "Hello." }] },
    { name: "Feels off signal only", transcript: [{ role: "user", text: "Feels off!!" }] },
  ])("empty or no-question transcript saves raw counts and scoredAt without a model ($name)", async ({ transcript }) => {
    const { record, session } = await calibration({ transcript });
    expect(await scoreCalibrationOnce(session.id)).toEqual({ turns: 0, off: 0 });
    expect(await saved(record.id)).toMatchObject({ turns: 0, offTurns: 0, scoredAt: expect.any(Date) });
    expect(model).not.toHaveBeenCalled();
  });
  test("a call without a calibration cannot claim scoring or call the model", async () => {
    const session = await f.session();
    expect(await scoreCalibrationOnce(session.id)).toBeNull();
    expect(await scoreCalibrationOnce("missing-session")).toBeNull();
    expect(model).not.toHaveBeenCalled();
  });
  test("calibration Check: post-15-Nov calls ended over an hour ago belong to their creator's twin and are scored, never reported", async () => {
    const createdAt = new Date("2026-11-15T23:00:00Z");
    const endedAt = new Date("2026-11-16T00:00:00Z");
    const now = new Date("2026-11-16T02:00:00Z");
    for (const status of ["completed", "abandoned"]) {
      const { record, session } = await calibration({ status, startedAt: createdAt, endedAt, evidence: { transcriptFinal: true } });
      await db.twinCalibration.update({ where: { id: record.id }, data: { createdAt } });
      expect(await endTwinSession(session.id)).toEqual({ status: "ended", calibration: "scored" });
      const call = await db.interviewSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(call.report).toBeNull();
      expect(call.reportStatus).toBe("none");
      expect(call.reportWorkflowRunId).toBeNull();
    }
    const checked = await db.twinCalibration.findMany({
      where: { createdAt: { gte: new Date("2026-11-15T00:00:00Z") }, session: { orgId: f.org.id, status: { in: ["completed", "abandoned"] }, endedAt: { lt: new Date(now.getTime() - 3600_000) } } },
      include: { session: { include: { agent: true } } },
    });
    expect(checked).toHaveLength(2);
    for (const row of checked) {
      expect(row.session.agent.kind).toBe("TWIN");
      expect(row.createdByUserId).toBe(row.session.userId);
      expect(row.scoredAt).toBeInstanceOf(Date);
      expect(row.turns).toBe(1);
    }
    expect(model).toHaveBeenCalledTimes(2);
  });

  test("readCalibration recognizes transcriptFinal only as true and score step persists the result", async () => {
    expect(await readCalibration("missing")).toBe("none");
    const ordinary = await f.session(); expect(await readCalibration(ordinary.id)).toBe("none");
    const { record, session } = await calibration({ evidence: { transcriptFinal: "true" } });
    expect(await readCalibration(session.id)).toBe("waiting");
    await db.interviewSession.update({ where: { id: session.id }, data: { evidence: { transcriptFinal: true } } });
    expect(await readCalibration(session.id)).toBe("ready");
    expect(scoreCalibration.maxRetries).toBe(3);
    await scoreCalibration(session.id);
    expect(await saved(record.id)).toMatchObject({ scoredAt: expect.any(Date), turns: 1, offTurns: 0 });
  });
});

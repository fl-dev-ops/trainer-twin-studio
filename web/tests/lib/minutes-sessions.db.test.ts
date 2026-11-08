import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as nextServer from "next/server";
import * as livekit from "@/lib/livekit";
import { activateInterviewRuntime } from "@/lib/session-activation";
import { activateSession, finalizeInterviewSession } from "@/lib/interview-sessions";
import { grantMinutes, learnerBalance, orgBalanceSeconds, recordSessionUsage, sessionUsageSeconds, topUpOrg } from "@/lib/minutes";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

describe.skipIf(!localMinutesDb)("metered sessions (local database)", () => {
  let f: MinutesFixture;
  let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
  let secret: string | undefined;
  beforeEach(async () => {
    f = minutesFixture();
    await f.create();
    secret = process.env.COPILOT_SERVICE_SECRET;
    process.env.COPILOT_SERVICE_SECRET = "minutes-test-secret";
    fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
  });
  afterEach(async () => {
    fetchMock?.mockRestore();
    if (secret === undefined) delete process.env.COPILOT_SERVICE_SECRET;
    else process.env.COPILOT_SERVICE_SECRET = secret;
    await f.clean();
  });
  const fund = async (amount = 10) => {
    await topUpOrg({ orgId: f.org.id, minutes: amount, note: "test" });
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: amount });
  };
  const activate = (extra: Partial<Parameters<typeof activateSession>[0]> = {}) => activateSession({
    orgId: f.org.id, userId: f.learner.id, userEmail: f.learner.email, agentSlug: f.roleplay.slug, mode: "voice", ...extra,
  });

  test("usage floors fractional seconds, caps at allowance, and clamps negative durations", () => {
    const row = { allowedSeconds: 600, startedAt: new Date(0), endedAt: new Date(90_999), status: "completed" };
    expect(sessionUsageSeconds(row)).toBe(90);
    expect(sessionUsageSeconds({ ...row, allowedSeconds: 30 })).toBe(30);
    expect(sessionUsageSeconds({ ...row, endedAt: new Date(-1) })).toBe(0);
    for (const missing of [{ startedAt: null }, { endedAt: null }, { allowedSeconds: null }]) expect(sessionUsageSeconds({ ...row, ...missing })).toBe(0);
  });

  test("a live call counts up to now, never more than its allowance, without a ledger row", async () => {
    await fund();
    const session = await f.session({ status: "active", startedAt: new Date(Date.now() - 90_000), endedAt: null, allowedSeconds: 120 });
    const used = (await learnerBalance(f.org.id, f.learner.email)).usedSeconds;
    expect(used).toBeGreaterThanOrEqual(89);
    expect(used).toBeLessThanOrEqual(95);
    await db.interviewSession.update({ where: { id: session.id }, data: { startedAt: new Date(Date.now() - 600_000) } });
    await recordSessionUsage(session.id); // still open: no durable charge
    expect((await learnerBalance(f.org.id, f.learner.email)).usedSeconds).toBe(120);
    expect(await db.minuteLedger.count({ where: { sessionId: session.id } })).toBe(0);
  });

  test("a closed call counts before recording, is capped and never double-counted after parallel writes", async () => {
    await fund();
    const session = await f.session({ allowedSeconds: 45 });
    expect((await learnerBalance(f.org.id, f.learner.email)).usedSeconds).toBe(45);
    await Promise.all(Array.from({ length: 12 }, () => recordSessionUsage(session.id)));
    expect(await db.minuteLedger.findMany({ where: { sessionId: session.id }, select: { seconds: true } })).toEqual([{ seconds: -45 }]);
    expect((await learnerBalance(f.org.id, f.learner.email)).usedSeconds).toBe(45);
    expect(await orgBalanceSeconds(f.org.id)).toBe(0); // usage doesn't debit the org again
  });

  test.each(["failed", "revoked"])("%s calls cost zero both before and after recording", async (status) => {
    const session = await f.session({ status });
    expect((await learnerBalance(f.org.id, f.learner.email)).usedSeconds).toBe(0);
    await recordSessionUsage(session.id);
    expect(await db.minuteLedger.findMany({ where: { sessionId: session.id }, select: { seconds: true } })).toEqual([{ seconds: 0 }]);
    expect((await learnerBalance(f.org.id, f.learner.email)).usedSeconds).toBe(0);
  });

  test("studio calls and missing sessions never produce usage rows", async () => {
    const session = await f.session({ allowedSeconds: null, userId: f.trainer.id });
    await recordSessionUsage(session.id);
    await recordSessionUsage("does-not-exist");
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
    expect((await learnerBalance(f.org.id, f.trainer.email)).usedSeconds).toBe(0);
  });

  test("finalize records usage once, preserves the first end time, and transcript-only updates do not charge", async () => {
    const session = await f.session({ status: "active", endedAt: null, startedAt: new Date(Date.now() - 90_000), allowedSeconds: 60 });
    await finalizeInterviewSession({ sessionId: session.id, transcript: [{ role: "user", content: "Hello" }] });
    expect(await db.minuteLedger.count({ where: { sessionId: session.id } })).toBe(0);
    await finalizeInterviewSession({ sessionId: session.id, requestedStatus: "completed" });
    const ended = await db.interviewSession.findUniqueOrThrow({ where: { id: session.id } });
    await finalizeInterviewSession({ sessionId: session.id, requestedStatus: "abandoned" });
    expect(await db.minuteLedger.findMany({ where: { sessionId: session.id }, select: { seconds: true } })).toEqual([{ seconds: -60 }]);
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: session.id }, select: { status: true, endedAt: true } }))
      .toEqual({ status: "completed", endedAt: ended.endedAt });
    expect(await finalizeInterviewSession({ sessionId: "missing", requestedStatus: "completed" })).toBeNull();
  });

  test("zero-balance learners are refused before runtime initialization or session creation", async () => {
    await expect(activate()).rejects.toMatchObject({ name: "MinutesError", status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  test("learners start voice calls with their balance as allowance and secondsLeft", async () => {
    await fund();
    const result = await activate();
    expect(result).toMatchObject({ status: "active", mode: "voice", secondsLeft: 600 });
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: result!.id } })).toMatchObject({ allowedSeconds: 600, status: "active" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each(["admin", "team"])("studio role %s starts without credit and is never metered", async (role) => {
    await db.member.update({ where: { id: `${f.trainer.id}-member` }, data: { role } });
    const result = await activate({ userId: f.trainer.id, userEmail: f.trainer.email });
    expect(result).toMatchObject({ secondsLeft: null });
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: result!.id } })).toMatchObject({ allowedSeconds: null });
    await finalizeInterviewSession({ sessionId: result!.id, requestedStatus: "completed" });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  test("metered chat sessions are refused without consuming credit", async () => {
    await fund();
    await expect(activate({ mode: "chat" })).rejects.toMatchObject({ name: "MinutesError", status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await learnerBalance(f.org.id, f.learner.email)).balanceSeconds).toBe(600);
  });

  test("a new call closes and charges the learner's other live call before setting its allowance", async () => {
    await fund();
    const old = await f.session({ status: "active", startedAt: new Date(Date.now() - 90_000), endedAt: null });
    const next = await activate();
    const closed = await db.interviewSession.findUniqueOrThrow({ where: { id: old.id } });
    expect(closed.status).toBe("abandoned");
    expect(closed.endedAt).not.toBeNull();
    const usage = await db.minuteLedger.findUniqueOrThrow({ where: { sessionId: old.id } });
    expect(usage.seconds).toBeLessThanOrEqual(-89);
    expect(usage.seconds).toBeGreaterThan(-100);
    expect(next).toMatchObject({ secondsLeft: 600 + usage.seconds });
    expect(await db.interviewSession.count({ where: { orgId: f.org.id, userId: f.learner.id, status: "active" } })).toBe(1);
  });

  test("runtime initialization failure leaves a failed call costing zero", async () => {
    await fund();
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(activate()).rejects.toThrow("Chat runtime initialization failed (503)");
    expect(await db.interviewSession.findFirstOrThrow({ where: { orgId: f.org.id } })).toMatchObject({ status: "failed" });
    expect((await learnerBalance(f.org.id, f.learner.email)).balanceSeconds).toBe(600);
  });

  test.each(["ROLEPLAY", "TWIN"])("runtime activation forwards the %s learner deadline and agent kind to LiveKit", async (kind) => {
    await fund();
    const agent = kind === "TWIN" ? f.twin : f.roleplay;
    if (kind === "TWIN") await db.twinAssignment.create({ data: { orgId: f.org.id, agentId: agent.id, recipientEmail: f.learner.email, minutesLimit: 30, shareCode: `${f.org.id}-twin` } });
    const after = spyOn(nextServer, "after").mockImplementation(() => {});
    const connect = spyOn(livekit, "activateLiveKitSession").mockResolvedValue({ room: "test-room", token: "participant", dispatchId: "dispatch", videoEgressId: null, videoS3Key: null });
    try {
      const before = Math.floor(Date.now() / 1000);
      await activateInterviewRuntime({ orgId: f.org.id, userId: f.learner.id, userEmail: f.learner.email, agentSlug: agent.slug, mode: "voice" });
      const call = connect.mock.calls[0][0];
      expect(call.agentKind).toBe(kind);
      expect(call.endsAt).toBeGreaterThanOrEqual(before + 600);
      expect(call.endsAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 600);
    } finally { connect.mockRestore(); after.mockRestore(); }
  });

  // Known regression: the idempotent activation branch omits secondsLeft, removing the LiveKit deadline on retry.
  test("BUG: resuming an active metered call returns its remaining seconds for deadline enforcement", async () => {
    await fund();
    const first = await activate({ idempotencyKey: "retry" });
    await db.interviewSession.update({ where: { id: first!.id }, data: { startedAt: new Date(Date.now() - 60_000) } });
    const resumed = await activate({ idempotencyKey: "retry" });
    expect(resumed?.id).toBe(first!.id);
    expect(resumed?.secondsLeft).toBeGreaterThanOrEqual(535);
    expect(resumed?.secondsLeft).toBeLessThanOrEqual(540);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

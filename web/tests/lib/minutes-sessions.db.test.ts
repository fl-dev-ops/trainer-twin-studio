import { fundOrg, availableOrgSeconds } from "../setup/meteroid";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as nextServer from "next/server";
import * as livekit from "@/lib/livekit";
import { ensureDeployment } from "@/lib/deployments";
import { MAX_STUDIO_CALL_MINUTES } from "@/lib/minutes-config";
import { startSessionNow } from "@/lib/session-activation";
import { activateSession, finalizeInterviewSession } from "@/lib/interview-sessions";
import { OUT_OF_MINUTES, grantMinutes, learnerBalance, recordSessionUsage, sessionUsageSeconds } from "@/lib/minutes";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

describe.skipIf(!localMinutesDb)("metered sessions (local database)", () => {
  let f: MinutesFixture;
  let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
  let secret: string | undefined;
  beforeEach(async () => {
    f = minutesFixture();
    await f.create();
    const deployment = await ensureDeployment(f.org.id, f.roleplay.id);
    await db.rolePlayAssignment.create({ data: { orgId: f.org.id, deploymentId: deployment.id, memberId: `${f.learner.id}-member`, shareCode: `${f.org.id}-roleplay`, assignedByUserId: f.trainer.id, expiresAt: new Date(0) } });
    secret = process.env.COPILOT_SERVICE_SECRET;
    process.env.COPILOT_SERVICE_SECRET = "minutes-test-secret";
    const networkFetch = globalThis.fetch;
    fetchMock = spyOn(globalThis, "fetch").mockImplementation((url, init) => String(url).includes("meteroid.test") ? networkFetch(url, init) : Promise.resolve(new Response(null, { status: 204 })));
  });
  afterEach(async () => {
    fetchMock?.mockRestore();
    if (secret === undefined) delete process.env.COPILOT_SERVICE_SECRET;
    else process.env.COPILOT_SERVICE_SECRET = secret;
    await f.clean();
  });
  const fund = async (amount = 10) => {
    await fundOrg({ orgId: f.org.id, minutes: amount, note: "test" });
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: amount });
    fetchMock.mockClear();
  };
  const activate = (extra: Partial<Parameters<typeof activateSession>[0]> = {}) => activateSession({
    orgId: f.org.id, userId: f.learner.id, userEmail: f.learner.email,
    ...(extra.userId === f.trainer.id ? { agentSlug: f.roleplay.slug } : { shareCode: `${f.org.id}-roleplay` }), mode: "voice", ...extra,
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
    expect(await availableOrgSeconds(f.org.id)).toBe(0); // usage doesn't debit the org again
  });

  test.each(["failed", "revoked"])("%s calls cost zero both before and after recording", async (status) => {
    const session = await f.session({ status });
    expect((await learnerBalance(f.org.id, f.learner.email)).usedSeconds).toBe(0);
    await recordSessionUsage(session.id);
    expect(await db.minuteLedger.findMany({ where: { sessionId: session.id }, select: { seconds: true } })).toEqual([]);
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
    await expect(activate()).rejects.toMatchObject({ name: "PracticeError", status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  test.each([0, 180, 299, 300])("learner start boundary at %s seconds is checked before runtime creation", async (seconds) => {
    await fund(5);
    if (seconds < 300) await f.session({ allowedSeconds: 300, startedAt: new Date(0), endedAt: new Date((300 - seconds) * 1000) });
    if (seconds === 300) {
      expect(await activate()).toMatchObject({ secondsLeft: 300 });
    } else {
      const before = await db.interviewSession.count({ where: { orgId: f.org.id } });
      await expect(activate()).rejects.toMatchObject({ name: "PracticeError", status: 403, message: seconds === 0 ? OUT_OF_MINUTES : `You need at least 5 minutes to start a call; you have ${Math.floor(seconds / 60)}. Ask your trainer for more.` });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(before);
    }
  });

  test.each(["admin", "team"])("billed %s refuses 299 seconds before creating a session", async (role) => {
    await db.member.update({ where: { id: `${f.trainer.id}-member` }, data: { role } });
    await fundOrg({ orgId: f.org.id, minutes: 299 / 60 });
    await expect(activate({ userId: f.trainer.id, userEmail: f.trainer.email })).rejects.toMatchObject({ name: "PracticeError", status: 403, message: "Your organization needs at least 5 credits to start a call; it has 4. Contact TrainerTwin to add more." });
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes("meteroid.test"))).toBe(true);
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  test.each([10, 60])("learner's %s minutes remain their allowance, without the studio cap", async (minutes) => {
    await fund(minutes);
    const result = await activate();
    expect(result).toMatchObject({ status: "active", mode: "voice", secondsLeft: minutes * 60 });
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: result!.id } })).toMatchObject({ allowedSeconds: minutes * 60, status: "active" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([5, 12, MAX_STUDIO_CALL_MINUTES])("studio allowance uses the available %s credits when at or below the cap", async (minutes) => {
    await fundOrg({ orgId: f.org.id, minutes });
    expect(await activate({ userId: f.trainer.id })).toMatchObject({ secondsLeft: minutes * 60 });
    expect(await availableOrgSeconds(f.org.id)).toBe(0);
  });

  test.each(["admin", "team"].flatMap((role) => ["twin", "calibration", "roleplay"].map((kind) => ({ role, kind }))))(
    "$role $kind call reserves only the studio cap and forwards that deadline to LiveKit",
    async ({ role, kind }) => {
      await db.member.update({ where: { id: `${f.trainer.id}-member` }, data: { role } });
      await fundOrg({ orgId: f.org.id, minutes: 100 });
      const agent = kind === "roleplay" ? f.roleplay : f.twin;
      const connect = spyOn(livekit, "activateLiveKitSession").mockResolvedValue({ room: "test-room", token: "participant", dispatchId: "dispatch", videoEgressId: null, videoS3Key: null });
      try {
        const before = Math.floor(Date.now() / 1000);
        const result = await startSessionNow({ orgId: f.org.id, userId: f.trainer.id, agentSlug: agent.slug, mode: "voice", calibrate: kind === "calibration" });
        if (!result.ok) throw new Error(result.error);
        const seconds = MAX_STUDIO_CALL_MINUTES * 60;
        expect(result.session.secondsLeft).toBe(seconds);
        expect(await db.interviewSession.findUniqueOrThrow({ where: { id: result.session.id } })).toMatchObject({ allowedSeconds: seconds, chargesOrg: true });
        expect(await availableOrgSeconds(f.org.id)).toBe((100 - MAX_STUDIO_CALL_MINUTES) * 60);
        expect(connect.mock.calls[0][0].endsAt).toBeGreaterThanOrEqual(before + seconds);
        expect(connect.mock.calls[0][0].endsAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + seconds);
        expect(await db.twinCalibration.count({ where: { sessionId: result.session.id } })).toBe(kind === "calibration" ? 1 : 0);
      } finally { connect.mockRestore(); }
    },
  );

  test.each([MAX_STUDIO_CALL_MINUTES, 60])("resuming a studio call keeps its original %s-minute allowance, without renewal", async (minutes) => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    const input = { userId: f.trainer.id, idempotencyKey: "studio-resume" };
    const first = await activate(input);
    // Also cover a call started before the cap: only new calls receive the new limit.
    await db.interviewSession.update({ where: { id: first!.id }, data: { allowedSeconds: minutes * 60, startedAt: new Date(Date.now() - 420_000) } });
    const resumed = await activate(input);
    expect(resumed).toMatchObject({ id: first!.id, resumed: true });
    expect(resumed!.secondsLeft).toBeGreaterThanOrEqual(minutes * 60 - 425);
    expect(resumed!.secondsLeft).toBeLessThanOrEqual(minutes * 60 - 420);
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: first!.id } })).toMatchObject({ allowedSeconds: minutes * 60 });
  });

  test.each(["admin", "team"])("studio role %s starts without credit and is never metered", async (role) => {
    await db.member.update({ where: { id: `${f.trainer.id}-member` }, data: { role } });
    const result = await activate({ userId: f.trainer.id, userEmail: f.trainer.email });
    expect(result).toMatchObject({ secondsLeft: null });
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: result!.id } })).toMatchObject({ allowedSeconds: null });
    await finalizeInterviewSession({ sessionId: result!.id, requestedStatus: "completed" });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  test.each(["admin", "team"])("billed %s voice calls use org credits directly; zero credits refuses before runtime", async (role) => {
    await db.member.update({ where: { id: `${f.trainer.id}-member` }, data: { role } });
    await fundOrg({ orgId: f.org.id, minutes: 0 });
    await expect(activate({ userId: f.trainer.id, userEmail: f.trainer.email })).rejects.toMatchObject({ name: "PracticeError", status: 403, code: "org_credits_out", message: "Your organization has no credits left. Contact TrainerTwin to add more." });
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(0);
    await fundOrg({ orgId: f.org.id, minutes: 5 });
    const result = await activate({ userId: f.trainer.id, userEmail: f.trainer.email });
    expect(result).toMatchObject({ secondsLeft: 300 });
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: result!.id } })).toMatchObject({ allowedSeconds: 300, chargesOrg: true });
    await db.interviewSession.update({ where: { id: result!.id }, data: { startedAt: new Date(Date.now() - 90_000) } });
    await finalizeInterviewSession({ sessionId: result!.id, requestedStatus: "completed" });
    expect(await db.minuteLedger.findUniqueOrThrow({ where: { sessionId: result!.id } })).toMatchObject({ type: "org_usage", email: f.trainer.email, seconds: expect.any(Number) });
  });

  test("billed studio chat remains unmetered even with zero org credits", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 0 });
    const result = await activate({ userId: f.trainer.id, userEmail: f.trainer.email, mode: "chat" });
    expect(result).toMatchObject({ secondsLeft: null });
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: result!.id } })).toMatchObject({ allowedSeconds: null, chargesOrg: false });
  });

  test("metered chat sessions are refused without consuming credit", async () => {
    await fund();
    await expect(activate({ mode: "chat" })).rejects.toMatchObject({ code: "mode_not_allowed", status: 400 });
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
    if (kind === "TWIN") await db.twinAssignment.create({ data: { orgId: f.org.id, agentId: agent.id, userId: f.learner.id, minutesLimit: 30, shareCode: `${f.org.id}-twin` } });
    const after = spyOn(nextServer, "after").mockImplementation(() => {});
    const connect = spyOn(livekit, "activateLiveKitSession").mockResolvedValue({ room: "test-room", token: "participant", dispatchId: "dispatch", videoEgressId: null, videoS3Key: null });
    try {
      const before = Math.floor(Date.now() / 1000);
      await startSessionNow({ orgId: f.org.id, userId: f.learner.id, userEmail: f.learner.email, shareCode: `${f.org.id}-${kind === "TWIN" ? "twin" : "roleplay"}`, mode: "voice" });
      const call = connect.mock.calls[0][0];
      expect(call.agentKind).toBe(kind);
      expect(call.endsAt).toBeGreaterThanOrEqual(before + 600);
      expect(call.endsAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 600);
    } finally { connect.mockRestore(); after.mockRestore(); }
  });

  test("resuming an active metered call returns its remaining seconds for deadline enforcement", async () => {
    await fund();
    const first = await activate({ idempotencyKey: "retry" });
    await db.interviewSession.update({ where: { id: first!.id }, data: { startedAt: new Date(Date.now() - 420_000) } });
    const resumed = await activate({ idempotencyKey: "retry" });
    expect(resumed?.id).toBe(first!.id);
    expect(resumed?.secondsLeft).toBeGreaterThanOrEqual(175);
    expect(resumed?.secondsLeft).toBeLessThanOrEqual(180);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as nextServer from "next/server";
import * as livekit from "@/lib/livekit";
import { ensureDeployment } from "@/lib/deployments";
import { activateSession, finalizeInterviewSession } from "@/lib/interview-sessions";
import { grantMinutes, learnerBalance, topUpOrg } from "@/lib/minutes";
import { activateInterviewRuntime } from "@/lib/session-activation";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

describe.skipIf(!localMinutesDb)("repeat role-play activation (local database)", () => {
  let f: MinutesFixture;
  let assignment: { id: string; shareCode: string };
  let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
  let connect: ReturnType<typeof spyOn<typeof livekit, "activateLiveKitSession">>;
  let close: ReturnType<typeof spyOn<typeof livekit, "closeLiveKitSession">>;
  let after: ReturnType<typeof spyOn<typeof nextServer, "after">>;
  let secret: string | undefined;
  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    secret = process.env.COPILOT_SERVICE_SECRET;
    process.env.COPILOT_SERVICE_SECRET = "roleplay-test-secret";
    fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    connect = spyOn(livekit, "activateLiveKitSession").mockResolvedValue({ room: "test-room", token: "test-token", dispatchId: "test-dispatch", videoEgressId: null, videoS3Key: null });
    close = spyOn(livekit, "closeLiveKitSession").mockResolvedValue(undefined);
    after = spyOn(nextServer, "after").mockImplementation(() => {});
    const deployment = await ensureDeployment(f.org.id, f.roleplay.id);
    assignment = await db.rolePlayAssignment.create({ data: {
      orgId: f.org.id, deploymentId: deployment.id, recipientEmail: f.learner.email,
      assignedByUserId: f.trainer.id, shareCode: `${f.org.id}-repeat`, expiresAt: new Date(0),
    } });
    await topUpOrg({ orgId: f.org.id, minutes: 10, note: "test" });
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 10 });
  });
  afterEach(async () => {
    fetchMock?.mockRestore(); connect?.mockRestore(); close?.mockRestore(); after?.mockRestore();
    if (secret === undefined) delete process.env.COPILOT_SERVICE_SECRET;
    else process.env.COPILOT_SERVICE_SECRET = secret;
    await f.clean();
  });
  const input = () => ({ orgId: f.org.id, userId: f.learner.id, userEmail: f.learner.email, shareCode: assignment.shareCode, mode: "voice" as const });
  const row = () => db.rolePlayAssignment.findUniqueOrThrow({ where: { id: assignment.id } });
  const sessions = () => db.interviewSession.findMany({ where: { orgId: f.org.id, assignmentId: assignment.id } });

  test.each(["completed", "abandoned"] as const)("start → %s → start makes distinct sessions and activation keys on the same assignment", async (requestedStatus) => {
    const first = await activateSession(input());
    expect(first).toMatchObject({ status: "active", secondsLeft: 600 });
    await db.interviewSession.update({ where: { id: first!.id }, data: { startedAt: new Date(Date.now() - 90_000) } });
    await finalizeInterviewSession({ sessionId: first!.id, requestedStatus });
    const charged = await db.minuteLedger.findUniqueOrThrow({ where: { sessionId: first!.id } });
    const second = await activateSession(input());
    expect(second!.id).not.toBe(first!.id);
    expect(second).toMatchObject({ status: "active", secondsLeft: 600 + charged.seconds });
    const practices = await sessions();
    expect(practices).toHaveLength(2);
    expect(new Set(practices.map((session) => session.activationKey)).size).toBe(2);
    for (const session of practices) expect(session.activationKey).toMatch(new RegExp(`^assignment:${assignment.id}:.+`));
    expect((await row()).status).toBe("used");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test.each(["activating", "active"])("a live %s session is resumed with its id, key and remaining allowance", async (status) => {
    const first = await activateSession(input());
    const previous = await db.interviewSession.update({ where: { id: first!.id }, data: { status, startedAt: new Date(Date.now() - 90_000) } });
    const resumed = await activateSession(input());
    expect(resumed).toMatchObject({ id: first!.id, status });
    expect(resumed?.secondsLeft).toBeGreaterThanOrEqual(505);
    expect(resumed?.secondsLeft).toBeLessThanOrEqual(510);
    expect(await sessions()).toMatchObject([{ id: first!.id, activationKey: previous.activationKey }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each(["pending", "used"])("a %s assignment with expiresAt in the past starts without becoming expired", async (status) => {
    await db.rolePlayAssignment.update({ where: { id: assignment.id }, data: { status } });
    expect(await activateSession(input())).toMatchObject({ status: "active" });
    expect(await row()).toMatchObject({ status: "used", expiresAt: new Date(0) });
  });

  test.each(["cancelled", "expired"])("a %s assignment status still blocks even with minutes", async (status) => {
    await db.rolePlayAssignment.update({ where: { id: assignment.id }, data: { status } });
    expect(await activateSession(input())).toBeNull();
    expect(await sessions()).toHaveLength(0);
    expect((await row()).status).toBe(status);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("wrong email and wrong org cannot start a role-play link", async () => {
    expect(await activateSession({ ...input(), userEmail: f.trainer.email })).toBeNull();
    expect(await activateSession({ ...input(), orgId: `${f.org.id}-missing` })).toBeNull();
    expect(await sessions()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a member-bound assignment rejects another user even with the recipient email", async () => {
    await db.rolePlayAssignment.update({ where: { id: assignment.id }, data: { memberId: `${f.learner.id}-member` } });
    expect(await activateSession({ ...input(), userId: f.trainer.id })).toBeNull();
    expect(await sessions()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a used link with exhausted minutes cannot start again", async () => {
    await db.rolePlayAssignment.update({ where: { id: assignment.id }, data: { status: "used" } });
    await f.session({ assignmentId: assignment.id, startedAt: new Date(0), endedAt: new Date(600_000) });
    await expect(activateSession(input())).rejects.toMatchObject({ name: "MinutesError", status: 403 });
    expect(await sessions()).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    { prior: "none", status: "failed", started: false, expected: "pending" },
    { prior: "failed start", status: "failed", started: true, expected: "pending" },
    { prior: "never started", status: "abandoned", started: false, expected: "pending" },
    { prior: "completed practice", status: "completed", started: true, expected: "used" },
    { prior: "abandoned practice", status: "abandoned", started: true, expected: "used" },
  ])("LiveKit failure after $prior leaves assignment $expected and charges no failed-call minutes", async ({ prior, status, started, expected }) => {
    if (prior !== "none") await f.session({ assignmentId: assignment.id, status, startedAt: started ? new Date("2026-01-01T00:00:00Z") : null });
    const balance = await learnerBalance(f.org.id, f.learner.email);
    const usedAt = new Date("2026-01-01T00:00:00Z");
    await db.rolePlayAssignment.update({ where: { id: assignment.id }, data: { status: "used", usedAt } });
    connect.mockRejectedValue(new Error("test LiveKit start failure"));
    await expect(activateInterviewRuntime(input())).rejects.toThrow("test LiveKit start failure");
    expect(await row()).toMatchObject({ status: expected });
    expect((await row()).usedAt === null).toBe(expected === "pending");
    const failed = await db.interviewSession.findFirstOrThrow({ where: { orgId: f.org.id, assignmentId: assignment.id }, orderBy: { createdAt: "desc" } });
    expect(failed).toMatchObject({ status: "failed", runtimeTokenHash: null });
    expect(failed.endedAt).not.toBeNull();
    expect((await learnerBalance(f.org.id, f.learner.email)).balanceSeconds).toBe(balance.balanceSeconds);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

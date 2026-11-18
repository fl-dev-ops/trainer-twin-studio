import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import * as workflow from "workflow/api";
import * as livekit from "@/lib/livekit";
import { startPublicTwinSession, endPublicTwinSession } from "@/lib/public-twin-sessions";
import { authorizeBrowserSession, authorizeRuntimeSession, browserToken, runtimeToken, tokenHash, finalizeInterviewSession } from "@/lib/interview-sessions";
import { expirePublicCall } from "@/workflows/steps/public-call-deadline";
import { enqueueWorkspaceCommand } from "@/lib/workspace-commands";
import { fundOrg, availableOrgSeconds } from "../setup/meteroid";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

describe.skipIf(!localMinutesDb)("public twin lifecycle (real database)", () => {
  let f: MinutesFixture;
  let oldSecret: string | undefined;
  const spies: { mockRestore(): void }[] = [];
  let scheduling: ReturnType<typeof spyOn<typeof workflow, "start">>;
  let transport: ReturnType<typeof spyOn<typeof livekit, "activateLiveKitSession">>;
  let network: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
  let initializeFails = false;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  beforeEach(async () => {
    f = minutesFixture();
    await f.create();
    await db.agent.update({ where: { id: f.twin.id }, data: { data: { publicAccess: { enabled: true, maxSeconds: 120 } } } });
    oldSecret = process.env.COPILOT_SERVICE_SECRET;
    initializeFails = false;
    process.env.COPILOT_SERVICE_SECRET = "public-twin-test-secret";
    scheduling = spyOn(workflow, "start").mockResolvedValue(undefined as never);
    transport = spyOn(livekit, "activateLiveKitSession").mockImplementation(async (input) => ({
      room: input.sessionId, token: "participant-token", dispatchId: "dispatch", videoEgressId: null, videoS3Key: null,
    }));
    const realFetch = globalThis.fetch;
    network = spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      if (String(url).includes("meteroid.test")) return realFetch(url, init);
      if (new URL(String(url)).pathname === "/internal/sessions") return Promise.resolve(new Response(null, { status: initializeFails ? 503 : 204 }));
      throw new Error(`Unexpected network request: ${String(url)}`);
    });
    spies.push(scheduling, transport, network, spyOn(livekit, "closeLiveKitSession").mockResolvedValue(undefined));
  });
  afterEach(async () => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
    if (oldSecret === undefined) delete process.env.COPILOT_SERVICE_SECRET;
    else process.env.COPILOT_SERVICE_SECRET = oldSecret;
    await f.clean();
  });
  const input = (visitor = randomUUID(), ip = visitor) => ({
    orgId: f.org.id, agentId: f.twin.id, visitorId: hash(visitor), ipHash: hash(ip), name: "  Public Visitor  ",
  });
  const seed = async (fields: Parameters<MinutesFixture["session"]>[0] = {}) => f.session({
    userId: null, agentId: f.twin.id, agentSlug: f.twin.slug, anonymousId: hash(randomUUID()), anonymousIpHash: hash(randomUUID()),
    anonymousName: "Visitor", mode: "voice", chargesOrg: true, allowedSeconds: 120,
    startedAt: new Date(Date.now() - 30_000), endedAt: null, status: "active", ...fields,
  });
  test("public finish completes server-side without a workspace client; other commands are refused", async () => {
    const row = await seed();
    await expect(enqueueWorkspaceCommand({
      orgId: f.org.id, sessionId: row.id, callId: randomUUID(), tool: "surface", payload: { action: "open_whiteboard" },
    })).rejects.toThrow("Workspaces are not available in public calls");
    const now = Date.now();
    spies.push(spyOn(Date, "now").mockReturnValue(now + 10_000));
    const callId = randomUUID();
    expect(await enqueueWorkspaceCommand({
      orgId: f.org.id, sessionId: row.id, callId, tool: "finish_session", payload: {},
    })).toMatchObject({ status: "completed", result: { ok: true } });
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "completed" });
    expect(await db.minuteLedger.findMany({ where: { sessionId: row.id } })).toHaveLength(1);
  });
  test("enabled start pins an anonymous voice session, reserves full credit, and exposes no agent token", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 5 });
    const userCount = () => db.user.count({ where: { OR: [{ id: { in: [f.learner.id, f.trainer.id] } }, { name: "Public Visitor" }] } });
    const before = await Promise.all([userCount(), db.member.count({ where: { organizationId: f.org.id } }), db.twinAssignment.count({ where: { orgId: f.org.id } }), db.minuteLedger.count({ where: { orgId: f.org.id } })]);
    const result = await startPublicTwinSession(input());
    expect(result.session).toMatchObject({ status: "active", mode: "voice", runtimeToken: browserToken(result.session.id) });
    expect(result.session).not.toHaveProperty("agentToken");
    const row = await db.interviewSession.findUniqueOrThrow({ where: { id: result.session.id } });
    expect(row).toMatchObject({ userId: null, anonymousName: "Public Visitor", chargesOrg: true, allowedSeconds: 120, assignmentId: null, twinAssignmentId: null, contextId: null, runtimeTokenHash: tokenHash(runtimeToken(row.id)) });
    expect(row.compiledSnapshot).not.toBeNull();
    expect(await availableOrgSeconds(f.org.id)).toBe(180);
    expect(await Promise.all([userCount(), db.member.count({ where: { organizationId: f.org.id } }), db.twinAssignment.count({ where: { orgId: f.org.id } }), db.minuteLedger.count({ where: { orgId: f.org.id } })])).toEqual(before);
    expect(scheduling.mock.calls[0][1]).toEqual([row.id, new Date(row.startedAt!.getTime() + 120_000).toISOString()]);
    expect(transport.mock.calls[0][0]).toMatchObject({ anonymous: true, userName: "Public Visitor", runtimeToken: runtimeToken(row.id), endsAt: Math.floor(row.startedAt!.getTime() / 1000) + 120 });
  });
  test.each(["off", "archived", "other-org", "roleplay", "invalid-name"])("refuses %s without session or runtime", async (state) => {
    await fundOrg({ orgId: f.org.id, minutes: 10 });
    const request = input();
    if (state === "off") await db.agent.update({ where: { id: f.twin.id }, data: { data: {} } });
    if (state === "archived") await db.agent.update({ where: { id: f.twin.id }, data: { archivedAt: new Date() } });
    if (state === "other-org") request.orgId = "different-org";
    if (state === "roleplay") request.agentId = f.roleplay.id;
    if (state === "invalid-name") request.name = " \n ";
    await expect(startPublicTwinSession(request)).rejects.toThrow();
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(scheduling).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
  test.each([null, 0, 119])("requires billed org and full allowance (%s seconds available)", async (seconds) => {
    if (seconds !== null) await fundOrg({ orgId: f.org.id, minutes: seconds / 60 });
    await expect(startPublicTwinSession(input())).rejects.toMatchObject({ code: "public_twin_unavailable" });
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(0);
  });
  test("parallel starts cannot overspend the org's last reservation", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 2 });
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => startPublicTwinSession(input())));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await availableOrgSeconds(f.org.id)).toBe(0);
    expect(await db.interviewSession.count({ where: { orgId: f.org.id, status: "active" } })).toBe(1);
  });
  test.each(["visitor", "ip"])("parallel starts share the %s concurrency bucket", async (bucket) => {
    await fundOrg({ orgId: f.org.id, minutes: 20 });
    const results = await Promise.allSettled(Array.from({ length: 4 }, (_, n) =>
      startPublicTwinSession(input(bucket === "visitor" ? "shared" : `visitor-${n}`, bucket === "ip" ? "shared" : `ip-${n}`))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").map((r) => r.reason.code)).toEqual(["public_call_busy", "public_call_busy", "public_call_busy"]);
  });
  test.each(["visitor", "ip"])("three recent starts exhaust the %s hourly bucket", async (bucket) => {
    await fundOrg({ orgId: f.org.id, minutes: 20 });
    const request = input();
    for (let n = 0; n < 3; n++) await seed({ status: "failed", endedAt: new Date(), ...(bucket === "visitor" ? { anonymousId: request.visitorId } : { anonymousIpHash: request.ipHash }) });
    await expect(startPublicTwinSession(request)).rejects.toMatchObject({ code: "public_call_limit", status: 429 });
  });
  test.each(["hourly", "concurrent"])("org %s quota applies across distinct visitors", async (quota) => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    for (let n = 0; n < (quota === "hourly" ? 30 : 5); n++) {
      await seed(quota === "hourly" ? { status: "failed", endedAt: new Date() } : {});
    }
    await expect(startPublicTwinSession(input())).rejects.toMatchObject({ code: quota === "hourly" ? "public_call_limit" : "public_call_busy" });
  });
  test.each(["hourly", "concurrent"])("parallel starts cannot race the final org %s slot", async (quota) => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    for (let n = 0; n < (quota === "hourly" ? 29 : 4); n++) {
      await seed(quota === "hourly" ? { status: "failed", endedAt: new Date() } : {});
    }
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => startPublicTwinSession(input())));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").map((r) => r.reason.code)).toEqual(
      Array(3).fill(quota === "hourly" ? "public_call_limit" : "public_call_busy"),
    );
  });
  test("parallel starts cannot race the final per-IP hourly slot using new visitor identities", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 20 });
    const ip = "shared-ip";
    for (let n = 0; n < 2; n++) await seed({ anonymousIpHash: hash(ip), status: "failed", endedAt: new Date() });
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => startPublicTwinSession(input(randomUUID(), ip))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").map((r) => r.reason.code)).toEqual(Array(3).fill("public_call_limit"));
  });
  test.each(["workflow", "initialize", "livekit"])("%s failure releases reservation and invalidates runtime credentials", async (failure) => {
    await fundOrg({ orgId: f.org.id, minutes: 2 });
    if (failure === "workflow") scheduling.mockRejectedValueOnce(new Error("workflow unavailable"));
    if (failure === "initialize") initializeFails = true;
    if (failure === "livekit") transport.mockRejectedValueOnce(new Error("livekit unavailable"));
    await expect(startPublicTwinSession(input())).rejects.toThrow();
    const row = await db.interviewSession.findFirstOrThrow({ where: { orgId: f.org.id } });
    expect(row).toMatchObject({ status: "failed", runtimeTokenHash: null, endedAt: expect.any(Date) });
    expect(await availableOrgSeconds(f.org.id)).toBe(120);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
    if (failure === "workflow") expect(transport).not.toHaveBeenCalled();
  });
  test("browser and agent tokens cannot cross sessions, roles, expiry or terminal status", async () => {
    const row = await seed();
    await db.interviewSession.update({ where: { id: row.id }, data: { runtimeTokenHash: tokenHash(runtimeToken(row.id)) } });
    const other = await seed();
    expect(await authorizeBrowserSession(row.id, browserToken(row.id))).toMatchObject({ id: row.id });
    expect(await authorizeRuntimeSession(row.id, runtimeToken(row.id))).toMatchObject({ id: row.id });
    expect(await authorizeRuntimeSession(row.id, browserToken(row.id))).toBeNull();
    expect(await authorizeBrowserSession(row.id, runtimeToken(row.id))).toBeNull();
    expect(await authorizeBrowserSession(other.id, browserToken(row.id))).toBeNull();
    expect(await authorizeRuntimeSession(other.id, runtimeToken(row.id))).toBeNull();
    await db.interviewSession.update({ where: { id: row.id }, data: { startedAt: new Date(Date.now() - 121_000) } });
    expect(await authorizeBrowserSession(row.id, browserToken(row.id))).toBeNull();
    expect(await authorizeRuntimeSession(row.id, runtimeToken(row.id))).toBeNull();
    await db.interviewSession.update({ where: { id: row.id }, data: { status: "completed", startedAt: new Date() } });
    expect(await authorizeBrowserSession(row.id, browserToken(row.id))).toBeNull();
    expect(await authorizeRuntimeSession(row.id, runtimeToken(row.id))).toBeNull();
  });
  test("end validates org, visitor and browser token; repeated finalization charges once and retains authoritative transcript", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 10 });
    const row = await seed({ startedAt: new Date(Date.now() - 180_000) });
    for (const override of [{ orgId: "other" }, { visitorId: hash("other") }, { token: browserToken("other") }, { token: runtimeToken(row.id) }]) {
      await expect(endPublicTwinSession({ sessionId: row.id, orgId: f.org.id, visitorId: row.anonymousId!, token: browserToken(row.id), ...override })).rejects.toMatchObject({ code: "not_found" });
    }
    await endPublicTwinSession({ sessionId: row.id, orgId: f.org.id, visitorId: row.anonymousId!, token: browserToken(row.id) });
    const ended = await db.interviewSession.findUniqueOrThrow({ where: { id: row.id } });
    const transcript = [{ role: "user", text: "Authoritative agent transcript" }];
    await Promise.all(Array.from({ length: 8 }, () => finalizeInterviewSession({ sessionId: row.id, requestedStatus: "completed", transcript, replaceTranscript: true, evidence: { transcriptFinal: true } })));
    await endPublicTwinSession({ sessionId: row.id, orgId: f.org.id, visitorId: row.anonymousId!, token: browserToken(row.id) });
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "completed", endedAt: ended.endedAt, transcript, evidence: { transcriptFinal: true }, runtimeTokenHash: null });
    expect(await db.minuteLedger.findMany({ where: { sessionId: row.id }, select: { type: true, seconds: true, userId: true } })).toEqual([{ type: "org_usage", seconds: -120, userId: null }]);
    expect(await availableOrgSeconds(f.org.id)).toBe(480);
  });
  test("deadline refuses early closure, then ends and charges exactly once", async () => {
    const row = await seed();
    await expect(expirePublicCall(row.id)).rejects.toThrow("Public call deadline has not arrived");
    await db.interviewSession.update({ where: { id: row.id }, data: { startedAt: new Date(Date.now() - 121_000) } });
    await expirePublicCall(row.id);
    await expirePublicCall(row.id);
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "abandoned", endedAt: expect.any(Date) });
    expect(await db.minuteLedger.count({ where: { sessionId: row.id } })).toBe(1);
  });
  test.each(["null-owner", "mixed-owner", "roleplay", "chat", "no-charge", "missing-allowance", "missing-ip", "context", "over-limit"])("database rejects %s anonymous shape", async (shape) => {
    const fields: Parameters<MinutesFixture["session"]>[0] = {
      ...(shape === "null-owner" ? { anonymousId: null, anonymousName: null, anonymousIpHash: null } : {}),
      ...(shape === "mixed-owner" ? { userId: f.trainer.id } : {}),
      ...(shape === "roleplay" ? { agentId: f.roleplay.id } : {}),
      ...(shape === "chat" ? { mode: "chat" } : {}),
      ...(shape === "no-charge" ? { chargesOrg: false } : {}),
      ...(shape === "missing-allowance" ? { allowedSeconds: null } : {}),
      ...(shape === "missing-ip" ? { anonymousIpHash: null } : {}),
      ...(shape === "context" ? { contextId: "unowned-document" } : {}),
      ...(shape === "over-limit" ? { allowedSeconds: 301 } : {}),
    };
    await expect(seed(fields)).rejects.toThrow();
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(0);
  });
});

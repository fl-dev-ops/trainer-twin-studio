import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import * as next from "next/server";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "../lib/minutes-test-db";
import { LearnerMemoryService } from "@/lib/learner-memory";
import * as identity from "@/lib/session-user";
import * as end from "@/lib/session-end";
import * as schedule from "@/lib/schedule-org-credits";
import * as s3 from "@/lib/s3";
import { authorizeBrowserSession, authorizeRuntimeSession, finalizeInterviewSession } from "@/lib/interview-sessions";
import { POST as start } from "@/app/api/sessions/route";
import { POST as finalize } from "@/app/api/sessions/finalize/route";
import { POST as webhook } from "@/app/api/sessions/webhook/route";
import { GET as commands } from "@/app/api/sessions/[id]/commands/route";
import { POST as completeCommand } from "@/app/api/sessions/[id]/commands/[callId]/route";
import { GET as readUi, POST as writeUi } from "@/app/api/sessions/[id]/ui-state/route";
import { GET as snapshot } from "@/app/api/sessions/[id]/route";
import { GET as video } from "@/app/api/sessions/[id]/video/route";
import { GET as apiSnapshot } from "@/app/api/v1/sessions/[id]/route";
import * as externalApi from "@/lib/external-api";

describe.skipIf(!localMinutesDb)("Module 5 owner finalize, two tokens and recording isolation (real database)", () => {
  let f: MinutesFixture;
  let call: { id: string };
  const agentToken = "agent-secret";
  const secret = "module-five-secret";
  let oldSecret: string | undefined;
  const spies: { mockRestore(): void }[] = [];
  const callbacks: (() => unknown)[] = [];
  let user: ReturnType<typeof spyOn<typeof identity, "resolveSessionUser">>;
  let memory: ReturnType<typeof spyOn<typeof LearnerMemoryService, "getCollection">>;
  let signing: ReturnType<typeof spyOn<typeof s3, "presignedGetUrl">>;
  beforeEach(async () => {
    f = minutesFixture(); await f.create(); callbacks.length = 0;
    oldSecret = process.env.COPILOT_SERVICE_SECRET; process.env.COPILOT_SERVICE_SECRET = secret;
    call = await f.session({ status: "active", startedAt: new Date(Date.now() - 90_000), endedAt: null, runtimeTokenHash: createHash("sha256").update(agentToken).digest("hex") });
    user = spyOn(identity, "resolveSessionUser").mockResolvedValue({ org: { ...f.org, accentColor: null }, user: f.learner, signInUrl: "/sign-in" });
    memory = spyOn(LearnerMemoryService, "getCollection").mockResolvedValue(null as never);
    signing = spyOn(s3, "presignedGetUrl").mockImplementation(async (key) => `https://s3.test/${key}`);
    spies.push(user, memory, signing,
      spyOn(LearnerMemoryService, "addMemory").mockResolvedValue(undefined),
      spyOn(next, "after").mockImplementation((fn) => { callbacks.push(fn as () => unknown); }),
      spyOn(end, "startSessionEnd").mockResolvedValue(undefined),
      spyOn(schedule, "scheduleOrgUsage").mockResolvedValue(undefined));
  });
  afterEach(async () => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
    if (oldSecret === undefined) delete process.env.COPILOT_SERVICE_SECRET; else process.env.COPILOT_SERVICE_SECRET = oldSecret;
    await f.clean();
  });
  const browserToken = () => createHmac("sha256", secret).update(`browser:${call.id}`).digest("base64url");
  const context = () => ({ params: Promise.resolve({ id: call.id, callId: "missing-command" }) });
  const request = (body: unknown = { sessionId: call.id, status: "abandoned" }, headers: HeadersInit = {}) => new Request("https://test/api/sessions/finalize", { method: "POST", headers, body: JSON.stringify(body) });
  const refuses = async (response: Response, code: string, status: number) => {
    expect(response.status).toBe(status); expect(await response.json()).toMatchObject({ code });
  };
  const browserRoutes = (token: string) => {
    const req = (method = "GET") => new Request(`https://test/api/sessions/${call.id}`, { method, headers: { authorization: `Bearer ${token}` }, ...(method === "POST" ? { body: JSON.stringify({ active: "code", key: "file.ts" }) } : {}) });
    return [() => commands(req(), context()), () => completeCommand(req("POST"), context()), () => readUi(req(), context()), () => writeUi(req("POST"), context()), () => snapshot(req(), context())];
  };
  test.each(["activating", "active"])("browser token works on commands, command completion, UI state and snapshot while %s; agent token stays separate", async (status) => {
    await db.interviewSession.update({ where: { id: call.id }, data: { status } });
    for (const route of browserRoutes(browserToken())) expect((await route()).status).toBe(200);
    expect(await authorizeBrowserSession(call.id, browserToken())).toMatchObject({ id: call.id });
    expect(await authorizeRuntimeSession(call.id, agentToken)).toMatchObject({ id: call.id });
    expect(await authorizeRuntimeSession(call.id, browserToken())).toBeNull();
    expect(await authorizeBrowserSession(call.id, agentToken)).toBeNull();
    expect(await authorizeBrowserSession("different-call", browserToken())).toBeNull();
  });
  test("closing permits only the agent's runtime authorization", async () => {
    await db.interviewSession.update({ where: { id: call.id }, data: { status: "closing" } });
    expect(await authorizeRuntimeSession(call.id, agentToken)).toMatchObject({ id: call.id });
    expect(await authorizeBrowserSession(call.id, browserToken())).toBeNull();
  });
  test.each(["wrong", "agent", "ended"])("refuses runtime_token_invalid on commands and UI for %s credentials without changing state", async (state) => {
    if (state === "ended") await finalizeInterviewSession({ sessionId: call.id, requestedStatus: "completed" });
    user.mockResolvedValue({ org: null, user: null, signInUrl: "/sign-in" });
    const token = state === "agent" ? agentToken : state === "ended" ? browserToken() : "wrong";
    const before = await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } });
    for (const route of browserRoutes(token).slice(0, 4)) await refuses(await route(), "runtime_token_invalid", 401);
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).toEqual(before);
    if (state === "ended") expect(await authorizeRuntimeSession(call.id, agentToken)).toBeNull();
  });
  test.each(["agent", "ended"])("snapshot bearer %s must return 401 runtime_token_invalid, actual 404 not_found", async (state) => {
    if (state === "ended") await finalizeInterviewSession({ sessionId: call.id, requestedStatus: "completed" });
    user.mockResolvedValue({ org: null, user: null, signInUrl: "/sign-in" });
    await refuses(await browserRoutes(state === "agent" ? agentToken : browserToken())[4](), "runtime_token_invalid", 401);
  });
  test("owner finalize ignores evidence, recording and transcriptFinal; browser transcript remains provisional; memory runs after", async () => {
    const transcript = [{ role: "user", text: "Browser's provisional answer" }];
    const response = await finalize(request({ sessionId: call.id, status: "abandoned", transcript, evidence: { videoS3Key: "another-org/video.mp4", transcriptFinal: true }, transcriptFinal: true, s3AudioKey: "ignored.wav" }));
    expect(response.status).toBe(200);
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({ status: "abandoned", transcript, evidence: null, s3AudioKey: null });
    expect(memory).not.toHaveBeenCalled(); expect(callbacks).toHaveLength(1);
    await callbacks[0](); expect(memory).toHaveBeenCalledWith(f.org.id, f.learner.id);
  });
  test.each(["header", "actual"])("finalize refuses >1 MB via %s without ending the call", async (how) => {
    const before = await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } });
    const req = how === "header" ? request(undefined, { "content-length": String(1024 * 1024 + 1) }) : request({ sessionId: call.id, status: "abandoned", text: "x".repeat(1024 * 1024) });
    await refuses(await finalize(req), "invalid_input", 400);
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).toEqual(before); expect(callbacks).toEqual([]);
  });
  test("finalize limits UTF-8 body bytes to 1 MB, actual checks UTF-16 characters and accepts >1 MB", async () => {
    const body = { sessionId: call.id, status: "abandoned", transcript: [{ role: "user", text: "界".repeat(360_000) }] };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(1024 * 1024);
    await refuses(await finalize(request(body)), "invalid_input", 400);
  });
  test.each(["disabled", "deleted", "another-owner"])("finalize refuses %s without modifying the call", async (state) => {
    if (state === "disabled") await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { disabledAt: new Date() } });
    if (state === "deleted") await db.interviewSession.update({ where: { id: call.id }, data: { deletedAt: new Date() } });
    if (state === "another-owner") user.mockResolvedValue({ org: { ...f.org, accentColor: null }, user: f.trainer, signInUrl: "/sign-in" });
    const before = await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } });
    await refuses(await finalize(request()), state === "disabled" ? "member_disabled" : "not_found", state === "disabled" ? 403 : 404);
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).toEqual(before); expect(callbacks).toEqual([]);
  });
  test("concurrent page finalize and agent COMPLETED keep the agent transcript, transcriptFinal, recording and first end time", async () => {
    await db.agent.update({ where: { id: f.roleplay.id }, data: { data: { after: { report: "roleplay" } } } });
    const transcript = [{ role: "user", text: "Agent's complete conversation" }, { role: "trainer", text: "Final answer" }];
    const videoKey = `${s3.orgPrefix(f.org.id)}/recordings/${call.id}/video.mp4`;
    const responses = await Promise.all([
      finalize(request({ sessionId: call.id, status: "abandoned", transcript: [{ role: "user", text: "Partial browser answer" }], evidence: { transcriptFinal: false } })),
      webhook(new Request("https://test/api/sessions/webhook", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ session_id: call.id, status: "COMPLETED", transcript, video_s3_key: videoKey }) })),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const row = await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } });
    expect(row).toMatchObject({ status: "completed", transcript, evidence: { transcriptFinal: true, videoS3Key: videoKey }, endedAt: expect.any(Date) });
    await finalize(request());
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({ status: "completed", transcript, evidence: row.evidence, endedAt: row.endedAt });
    expect(await db.minuteLedger.count({ where: { sessionId: call.id } })).toBe(1);
  });
  test.each(["another-org/video.mp4", "prefix-neighbor"])("video routes never sign another org's evidence key (%s)", async (key) => {
    const unsafe = key === "prefix-neighbor" ? `${s3.orgPrefix(f.org.id)}-other/video.mp4` : `${s3.orgPrefix("another-org")}/video.mp4`;
    await db.interviewSession.update({ where: { id: call.id }, data: { evidence: { videoS3Key: unsafe }, videoEgressId: "egress" } });
    expect((await video(new Request("https://test/video"), context())).status).toBe(307);
    spies.push(spyOn(externalApi, "requireExternalApi").mockResolvedValue({ org: f.org } as never));
    expect((await apiSnapshot(new Request("https://test/v1/session"), context())).status).toBe(200);
    expect(signing.mock.calls.map(([key]) => key)).toEqual(Array(2).fill(`${s3.orgPrefix(f.org.id)}/recordings/${call.id}/video.mp4`));
  });
  test("refuses signed_out on Start and finalize without ending anything", async () => {
    user.mockResolvedValue({ org: { ...f.org, accentColor: null }, user: null, signInUrl: "/sign-in" });
    for (const route of [start, finalize]) await refuses(await route(request({})), "signed_out", 401);
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({ status: "active" });
  });
  test("Start missing its agent/link is invalid_input", async () => { await refuses(await start(request({})), "invalid_input", 400); });
  test("obsolete browser agent-write routes are absent: no PATCH sessions or recording upload", async () => {
    const route = await import("@/app/api/sessions/route");
    expect(route).not.toHaveProperty("PATCH");
    expect(await Bun.file(new URL("../../app/api/sessions/recording/route.ts", import.meta.url)).exists()).toBe(false);
  });
});

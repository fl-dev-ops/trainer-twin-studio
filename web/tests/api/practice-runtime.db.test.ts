import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "../lib/minutes-test-db";
import { LearnerMemoryService } from "@/lib/learner-memory";
import * as identity from "@/lib/session-user";
import * as end from "@/lib/session-end";
import * as schedule from "@/lib/schedule-org-credits";
import { finalizeInterviewSession } from "@/lib/interview-sessions";
const stored: { key: string; bytes: number }[] = [];
// S3 is an external trust boundary; keep runtime authorization, route and database real.
mock.module("@/lib/s3", () => ({
  s3Configured: true,
  recordingKey: (org: string, id: string) => `${org}/${id}.wav`,
  putObject: async (key: string, body: Uint8Array) => { stored.push({ key, bytes: body.length }); },
  presignedGetUrl: async (key: string) => `https://s3.test/${key}`,
}));
const { PATCH, POST: start } = await import("@/app/api/sessions/route");
const { POST: recording } = await import("@/app/api/sessions/recording/route");
const { POST: finalize } = await import("@/app/api/sessions/finalize/route");

describe.skipIf(!localMinutesDb)("Module 2 runtime and request refusals (real database)", () => {
  let f: MinutesFixture;
  let call: { id: string };
  const token = "runtime-secret";
  const spies: { mockRestore(): void }[] = [];
  let user: ReturnType<typeof spyOn<typeof identity, "resolveSessionUser">>;
  beforeEach(async () => {
    f = minutesFixture(); await f.create(); stored.length = 0;
    call = await f.session({ status: "active", startedAt: new Date(Date.now() - 90_000), endedAt: null, runtimeTokenHash: createHash("sha256").update(token).digest("hex") });
    user = spyOn(identity, "resolveSessionUser").mockResolvedValue({ org: { ...f.org, accentColor: null }, user: f.learner, signInUrl: "/sign-in" });
    spies.push(user, spyOn(end, "startSessionEnd").mockResolvedValue(undefined), spyOn(schedule, "scheduleOrgUsage").mockResolvedValue(undefined), spyOn(LearnerMemoryService, "getCollection").mockResolvedValue(null as never));
  });
  afterEach(async () => { for (const spy of spies.splice(0).reverse()) spy.mockRestore(); await f.clean(); });
  const patch = (auth = token) => PATCH(new Request("https://test/api/sessions", { method: "PATCH", headers: auth ? { authorization: `Bearer ${auth}` } : {}, body: JSON.stringify({ id: call.id, status: "completed" }) }));
  const uploadRequest = (auth = token, length?: number) => new Request(`https://test/api/sessions/recording?sessionId=${call.id}`, { method: "POST", headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(length === undefined ? {} : { "content-length": String(length) }) }, body: new Uint8Array([1, 2, 3]) });
  const refuses = async (response: Response, code: string, status: number, message: string) => {
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ code, error: message });
  };
  test.each(["", "wrong", "ended"])("refuses runtime_token_invalid on PATCH and recording for %s token state", async (state) => {
    if (state === "ended") await finalizeInterviewSession({ sessionId: call.id, requestedStatus: "completed" });
    const before = await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } });
    const auth = state === "ended" ? token : state;
    await refuses(await patch(auth), "runtime_token_invalid", 401, "This call is no longer available.");
    await refuses(await recording(uploadRequest(auth)), "runtime_token_invalid", 401, "This call is no longer available.");
    expect(stored).toEqual([]); expect(await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).toEqual(before);
  });
  test.each(["content-length", "actual"])("refuses recording_too_big over 200 MB via %s, without storage or DB update", async (how) => {
    const bytes = 200 * 1024 * 1024 + 1;
    const request = uploadRequest(token, how === "content-length" ? bytes : undefined);
    const read = spyOn(request, "arrayBuffer").mockResolvedValue(how === "actual" ? new ArrayBuffer(bytes) : new ArrayBuffer(1));
    try {
      const before = await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } });
      await refuses(await recording(request), "recording_too_big", 413, "A recording can be at most 200 MB.");
      expect(read).toHaveBeenCalledTimes(how === "actual" ? 1 : 0);
      expect(stored).toEqual([]); expect(await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).toEqual(before);
    } finally { read.mockRestore(); }
  });
  test("a valid live runtime token can store a recording; owner finalize cannot set its recording", async () => {
    const response = await recording(uploadRequest()); expect(response.status).toBe(200);
    expect(stored).toEqual([{ key: `${f.org.id}/${call.id}.wav`, bytes: 3 }]);
    const existing = await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } });
    // Refusal before Chroma memory hook: another account cannot end this call or replace the recording.
    user.mockResolvedValue({ org: { ...f.org, accentColor: null }, user: f.trainer, signInUrl: "/sign-in" });
    await refuses(await finalize(new Request("https://test/api/sessions/finalize", { method: "POST", body: JSON.stringify({ sessionId: call.id, status: "completed", s3AudioKey: "attacker.wav" }) })), "not_found", 404, "Not found.");
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).toEqual(existing);
    user.mockResolvedValue({ org: { ...f.org, accentColor: null }, user: f.learner, signInUrl: "/sign-in" });
    const own = await finalize(new Request("https://test/api/sessions/finalize", { method: "POST", body: JSON.stringify({ sessionId: call.id, status: "completed", s3AudioKey: "ignored.wav" }) }));
    expect(own.status).toBe(200);
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({ status: "completed", s3AudioKey: existing.s3AudioKey });
  });
  test("refuses signed_out on Start and owner finalize, without ending anything", async () => {
    user.mockResolvedValue({ org: { ...f.org, accentColor: null }, user: null, signInUrl: "/sign-in" });
    for (const route of [start, finalize]) await refuses(await route(new Request("https://test/api/sessions", { method: "POST", body: "{}" })), "signed_out", 401, "Sign in first.");
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({ status: "active" });
  });
  test("refuses invalid_input on Start missing its agent/link", async () => {
    await refuses(await start(new Request("https://test/api/sessions", { method: "POST", body: "{}" })), "invalid_input", 400, "shareCode or agentSlug is required");
  });
});

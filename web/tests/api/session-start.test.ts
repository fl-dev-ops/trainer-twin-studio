import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as next from "next/server";
import * as identity from "@/lib/session-user";
import * as runner from "@/lib/run-session-start";
import * as warm from "@/lib/session-warm";
import { POST } from "@/app/api/sessions/route";
import type { OpenedSession } from "@/lib/session-activation";

const session = { id: "session", runtimeToken: "browser", agentToken: "agent", secondsLeft: 300 } as OpenedSession;
const { agentToken: _agentToken, ...publicSession } = session;
let start: ReturnType<typeof spyOn<typeof runner, "runSessionStart">>;
let after: ReturnType<typeof spyOn<typeof next, "after">>;
let warming: ReturnType<typeof spyOn<typeof warm, "warmChatOpening">>;
let user: ReturnType<typeof spyOn<typeof identity, "resolveSessionUser">>;
let log: ReturnType<typeof spyOn<typeof console, "error">>;
const callbacks: (() => unknown)[] = [];
beforeEach(() => {
  callbacks.length = 0;
  start = spyOn(runner, "runSessionStart").mockResolvedValue({ ok: true, session, participantToken: "participant", room: "room" });
  after = spyOn(next, "after").mockImplementation((fn) => { callbacks.push(fn as () => unknown); });
  warming = spyOn(warm, "warmChatOpening").mockResolvedValue(undefined);
  user = spyOn(identity, "resolveSessionUser").mockResolvedValue({ org: { id: "org" }, user: { id: "learner", name: "Learner", email: "learner@example.com" } } as never);
  log = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { for (const spy of [start, after, warming, user, log]) spy.mockRestore(); });
const request = (body: unknown = { shareCode: "invite" }) => new Request("https://example.com/api/sessions", { method: "POST", body: JSON.stringify(body) });

test.each([
  { ok: false as const, status: 403, error: "Need minutes", code: "minutes" as const },
  { ok: false as const, status: 400, error: "Context not found" },
])("POST returns the refusal's status and only its public fields: $error", async (refusal) => {
  start.mockResolvedValue(refusal);
  const response = await POST(request());
  expect(response.status).toBe(refusal.status);
  expect(await response.json()).toEqual({ error: refusal.error, ...("code" in refusal ? { code: refusal.code } : {}) });
  expect(after).not.toHaveBeenCalled();
});
test("POST voice returns browser credentials without agentToken and schedules warmup after the response", async () => {
  const response = await POST(request({ shareCode: "invite", idempotencyKey: "retry", holdOpening: true }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ session: publicSession, participantToken: "participant", room: "room" });
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org", userId: "learner", userEmail: "learner@example.com", shareCode: "invite", mode: "voice", idempotencyKey: "retry", holdOpening: true }));
  expect(callbacks).toHaveLength(1);
  expect(warming).not.toHaveBeenCalled();
  await callbacks[0]();
  expect(warming).toHaveBeenCalledWith("session", "org");
});
test.each([true, false, "true", 1, null])("POST passes calibrate only for literal true and returns calibrationId (%j)", async (calibrate) => {
  const calibrated = { ...session, calibrationId: "calibration" };
  start.mockResolvedValue({ ok: true, session: calibrated, participantToken: "participant", room: "room" });
  const response = await POST(request({ shareCode: "invite", calibrate }));
  expect(response.status).toBe(200);
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ calibrate: calibrate === true }));
  expect(await response.json()).toMatchObject({ session: { calibrationId: "calibration" } });
});

test("POST chat omits undefined voice credentials", async () => {
  start.mockResolvedValue({ ok: true, session, conversationToken: "agent" });
  const response = await POST(request({ shareCode: "invite", mode: "chat" }));
  expect(await response.json()).toEqual({ session: publicSession, conversationToken: "agent" });
});
test("unexpected start failures return a generic 500 without leaking internal errors", async () => {
  start.mockRejectedValue(new Error("private connection details"));
  const response = await POST(request());
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "Could not start the session. Please try again or contact support." });
  expect(after).not.toHaveBeenCalled();
});
test("unauthenticated and malformed starts never run the workflow", async () => {
  expect((await POST(request({}))).status).toBe(400);
  user.mockResolvedValue({ org: null, user: null } as never);
  expect((await POST(request())).status).toBe(401);
  expect(start).not.toHaveBeenCalled();
});

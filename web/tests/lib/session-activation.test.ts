import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as sessions from "@/lib/interview-sessions";
import * as livekit from "@/lib/livekit";

import { BEFORE_UPLOAD_REFUSED } from "@/lib/context-upload";
import { AppError } from "@/lib/errors";
import { MinutesError } from "@/lib/minutes";
import { TwinAccessError } from "@/lib/twin-access";
import { connectVoice, openSession, startRefusal, startSessionNow, type OpenedSession } from "@/lib/session-activation";

const db = {
  interviewSession: {
    findUniqueOrThrow: mock(async () => ({ id: "session", agentSlug: "agent", assignmentId: null, agent: { data: {}, kind: "ROLEPLAY", persona: { voiceId: null } }, livekitRoom: "old-room", livekitDispatchId: "old-dispatch", videoEgressId: null })),
    update: mock(async () => ({})),
    updateMany: mock(async (_args: unknown) => ({ count: 1 })),
  },
  voice: { findFirst: mock(async () => null) },
};
mock.module("@/lib/db", () => ({ db, withLock: async () => { throw new Error("Unexpected locked write"); } }));

const input = { orgId: "org", userId: "learner", mode: "voice" as const };
const session = { id: "session", runtimeToken: "runtime", secondsLeft: 300 } as OpenedSession;
let activate: ReturnType<typeof spyOn<typeof sessions, "activateSession">>;
let connect: ReturnType<typeof spyOn<typeof livekit, "activateLiveKitSession">>;
let close: ReturnType<typeof spyOn<typeof livekit, "closeLiveKitSession">>;
const spies: { mockRestore(): void }[] = [];
beforeEach(() => {
  activate = spyOn(sessions, "activateSession").mockResolvedValue(session);
  connect = spyOn(livekit, "activateLiveKitSession").mockResolvedValue({ token: "participant", room: "room", dispatchId: "dispatch", videoEgressId: null, videoS3Key: null });
  close = spyOn(livekit, "closeLiveKitSession").mockResolvedValue(undefined);
  db.interviewSession.updateMany.mockClear();
  spies.push(activate, connect, close);
});
afterEach(() => { for (const spy of spies.splice(0).reverse()) spy.mockRestore(); });

test.each([
  [new MinutesError("Need minutes", 403), { status: 403, code: "minutes", error: "Need minutes" }],
  [new AppError("member_disabled", "Disabled", 403), { status: 403, error: "Disabled", code: "member_disabled" }],
  [new TwinAccessError("No access", 404), { status: 404, error: "No access" }],
  ...["Context not found", BEFORE_UPLOAD_REFUSED, "Deployment does not allow chat"].map((message) => [new Error(message), { status: 400, error: message }]),
])("startRefusal maps expected refusals: %s", (error, expected) => {
  expect(startRefusal(error)).toEqual({ ok: false, ...expected });
});

test("startRefusal leaves unknown errors and non-errors unclassified", () => {
  for (const error of [new Error("database unavailable"), "Context not found", null]) expect(startRefusal(error)).toBeNull();
});

test("openSession returns invalid-link and minutes refusals, but throws unknown failures", async () => {
  activate.mockResolvedValueOnce(null);
  expect(await openSession(input)).toEqual({ ok: false, status: 403, error: "Invalid or already used session URL" });
  activate.mockRejectedValueOnce(new MinutesError("Need minutes", 403));
  expect(await openSession(input)).toEqual({ ok: false, status: 403, error: "Need minutes", code: "minutes" });
  const error = new Error("database unavailable");
  activate.mockRejectedValueOnce(error);
  await expect(openSession(input)).rejects.toBe(error);
  expect(connect).not.toHaveBeenCalled();
});

test("startSessionNow opens before connecting voice and returns credentials with the session", async () => {
  expect(await startSessionNow(input)).toEqual({ ok: true, session, participantToken: "participant", room: "room" });
  expect(activate).toHaveBeenCalledWith(input);
  expect(activate.mock.invocationCallOrder[0]).toBeLessThan(connect.mock.invocationCallOrder[0]);
  expect(connect).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session.id, runtimeToken: session.runtimeToken, agentKind: "ROLEPLAY", endsAt: expect.any(Number) }));
});

test("startSessionNow chat returns the conversation token without LiveKit", async () => {
  expect(await startSessionNow({ ...input, mode: "chat" })).toEqual({ ok: true, session, conversationToken: "runtime" });
  expect(connect).not.toHaveBeenCalled();
});

test("startSessionNow never connects a refused session", async () => {
  activate.mockRejectedValue(new MinutesError("Need minutes", 403));
  expect(await startSessionNow(input)).toMatchObject({ ok: false, code: "minutes" });
  expect(connect).not.toHaveBeenCalled();
});

test("connectVoice closes LiveKit and invalidates a failed session even if closing fails", async () => {
  const failed = db.interviewSession.updateMany;
  const error = new Error("dispatch failed");
  connect.mockRejectedValue(error);
  close.mockRejectedValue(new Error("room cleanup unavailable"));
  await expect(connectVoice(input, session)).rejects.toBe(error);
  expect(close).toHaveBeenCalledWith({ room: "old-room", dispatchId: "old-dispatch", videoEgressId: null });
  expect(failed).toHaveBeenCalledWith({ where: { id: "session", status: { notIn: ["completed", "abandoned"] } }, data: { status: "failed", endedAt: expect.any(Date), runtimeTokenHash: null } });
});

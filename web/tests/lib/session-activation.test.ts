import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as sessions from "@/lib/interview-sessions";
import * as livekit from "@/lib/livekit";

import { BEFORE_UPLOAD_REFUSED } from "@/lib/context-upload";
import { AppError } from "@/lib/errors";
import { MinutesError } from "@/lib/minutes";
import { TwinAccessError } from "@/lib/twin-access";
import { connectVoice, openSession, startRefusal, startSessionNow, type OpenedSession } from "@/lib/session-activation";
import type { Prisma, Voice } from "@/lib/generated/prisma/client";
import { voicePrefix } from "@/lib/s3";

const sessionRow = () => ({
  id: "session",
  mode: "voice",
  agentSlug: "agent",
  resolvedVoiceId: "voice" as string | null,
  compiledSnapshot: null as Prisma.JsonValue,
  agent: { data: {} as Record<string, unknown>, kind: "ROLEPLAY", persona: { voiceId: null as string | null } },
  livekitRoom: "old-room",
  livekitDispatchId: "old-dispatch",
  videoEgressId: null,
  startedAt: new Date("2026-11-18T10:00:00Z") as Date | null,
  allowedSeconds: 300 as number | null,
  anonymousId: null as string | null,
});
let row = sessionRow();
const voice = (id = "voice", orgId: string | null = "org"): Voice => ({
  id, orgId, name: id, kind: orgId ? "cloned" : "sample", status: "ready",
  s3AudioKey: `${voicePrefix(orgId, id)}/reference.wav`, s3TranscriptKey: null,
  createdAt: new Date(), updatedAt: new Date(),
});
const db = {
  $queryRaw: mock(async () => []),
  interviewSession: {
    findFirst: mock<(args: unknown) => Promise<ReturnType<typeof sessionRow> | null>>(async () => row),
    update: mock(async (args: { data: { resolvedVoiceId?: string } }) => {
      if (args.data.resolvedVoiceId) row.resolvedVoiceId = args.data.resolvedVoiceId;
      return {};
    }),
    updateMany: mock<(args: unknown) => Promise<{ count: number }>>(async () => ({ count: 1 })),
  },
  voice: {
    findFirst: mock(async (args: { where: Prisma.VoiceWhereInput }): Promise<Voice | null> => voice(typeof args.where.id === "string" ? args.where.id : "sample", typeof args.where.id === "string" ? "org" : null)),
    findMany: mock<(args: { where: Prisma.VoiceWhereInput }) => Promise<Voice[]>>(async () => [voice("sample", null)]),
  },
};
mock.module("@/lib/db", () => ({ db, withLock: async (_keys: string[], work: (tx: typeof db) => Promise<unknown>) => work(db) }));

const input = { orgId: "org", userId: "learner", mode: "voice" as const };
const session = { id: "session", runtimeToken: "browser", agentToken: "agent", secondsLeft: 300 } as OpenedSession;
let activate: ReturnType<typeof spyOn<typeof sessions, "activateSession">>;
let connect: ReturnType<typeof spyOn<typeof livekit, "activateLiveKitSession">>;
let close: ReturnType<typeof spyOn<typeof livekit, "closeLiveKitSession">>;
const spies: { mockRestore(): void }[] = [];
beforeEach(() => {
  row = sessionRow();
  db.interviewSession.findFirst.mockClear();
  db.interviewSession.findFirst.mockImplementation(async () => row);
  db.interviewSession.update.mockClear();
  db.voice.findFirst.mockClear();
  db.voice.findFirst.mockImplementation(async (args) => voice(typeof args.where.id === "string" ? args.where.id : "sample", typeof args.where.id === "string" ? "org" : null));
  db.voice.findMany.mockClear();
  db.voice.findMany.mockImplementation(async () => [voice("sample", null)]);
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
  [new TwinAccessError("twin_not_assigned", "No access", 403), { status: 403, code: "twin_not_assigned", error: "No access" }],
  ...["Context not found", BEFORE_UPLOAD_REFUSED, "Deployment does not allow chat"].map((message) => [new Error(message), { status: 400, error: message }]),
])("startRefusal maps expected refusals: %s", (error, expected) => {
  expect(startRefusal(error)).toEqual({ ok: false, ...expected });
});

test("startRefusal leaves unknown errors and non-errors unclassified", () => {
  for (const error of [new Error("database unavailable"), "Context not found", null]) expect(startRefusal(error)).toBeNull();
});

test("openSession returns not_found for an invalid link, minutes refusals, and throws unknown failures", async () => {
  activate.mockResolvedValueOnce(null);
  expect(await openSession(input)).toEqual({ ok: false, status: 404, error: "Not found.", code: "not_found" });
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
  expect(connect).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session.id, runtimeToken: session.agentToken, agentKind: "ROLEPLAY", endsAt: Math.floor(new Date("2026-11-18T10:00:00Z").getTime() / 1000) + 300 }));
});

test("startSessionNow chat returns the conversation token without LiveKit", async () => {
  expect(await startSessionNow({ ...input, mode: "chat" })).toEqual({ ok: true, session, conversationToken: "agent" });
  expect(connect).not.toHaveBeenCalled();
});

test("startSessionNow never connects a refused session", async () => {
  activate.mockRejectedValue(new MinutesError("Need minutes", 403));
  expect(await startSessionNow(input)).toMatchObject({ ok: false, code: "minutes" });
  expect(connect).not.toHaveBeenCalled();
});

test("connectVoice keeps its native voice pin after agent and persona switches", async () => {
  row.agent.data = { voiceId: "new-agent-voice" };
  row.agent.persona.voiceId = "new-persona-voice";
  await connectVoice(input, session);
  await connectVoice(input, { ...session, resumed: true });
  expect(connect).toHaveBeenCalledTimes(2);
  for (const [dispatch] of connect.mock.calls) expect(dispatch.voice).toBe("voice");
  for (const [query] of db.voice.findFirst.mock.calls) expect(query.where.id).toBe("voice");
  expect(db.interviewSession.update.mock.calls.some(([write]) => write.data.resolvedVoiceId)).toBe(false);
});

test("a native pin does not revalidate later configuration edits", async () => {
  row.agent.data = { voiceId: 42 };
  row.compiledSnapshot = { agent: { data: { voiceId: 42 } } };
  await connectVoice(input, { ...session, resumed: true });
  expect(connect).toHaveBeenCalledWith(expect.objectContaining({ voice: "voice" }));
});

test("legacy connection pins its recorded snapshot override once, not the live persona", async () => {
  row.resolvedVoiceId = null;
  row.compiledSnapshot = { agent: { data: { voiceId: "snapshot-voice" } } };
  row.agent.persona.voiceId = "live-voice";
  await connectVoice(input, session);
  expect(row.resolvedVoiceId).toBe("snapshot-voice");
  row.agent.persona.voiceId = "another-live-voice";
  await connectVoice(input, { ...session, resumed: true });
  for (const [dispatch] of connect.mock.calls) expect(dispatch.voice).toBe("snapshot-voice");
  expect(db.interviewSession.update.mock.calls.filter(([write]) => write.data.resolvedVoiceId)).toHaveLength(1);
});

test("legacy unconfigured sessions can pin only the eligible global sample default", async () => {
  row.resolvedVoiceId = null;
  await connectVoice(input, session);
  expect(row.resolvedVoiceId).toBe("sample");
  expect(db.voice.findMany.mock.calls[0][0].where).toEqual({ status: "ready", s3AudioKey: { not: "" }, OR: [{ orgId: null }] });
  expect(db.voice.findFirst.mock.calls[0][0].where).toMatchObject({ id: "sample", AND: [{ status: "ready", s3AudioKey: { not: "" }, OR: [{ orgId: "org" }, { orgId: null, kind: "sample" }] }] });
  expect(connect).toHaveBeenCalledWith(expect.objectContaining({ voice: "sample" }));
});

test("legacy recorded persona voice takes precedence over today's agent override", async () => {
  row.resolvedVoiceId = null;
  row.compiledSnapshot = { persona: { data: { voiceId: "recorded-persona" } } };
  row.agent.data = { voiceId: "new-override" };
  await connectVoice(input, session);
  expect(row.resolvedVoiceId).toBe("recorded-persona");
  expect(connect).toHaveBeenCalledWith(expect.objectContaining({ voice: "recorded-persona" }));
});

test("malformed recorded selections fail closed instead of becoming a default voice", async () => {
  row.resolvedVoiceId = null;
  row.compiledSnapshot = { agent: { data: { voiceId: 42 } } };
  await expect(connectVoice(input, session)).rejects.toMatchObject({ code: "invalid_input", status: 400 });
  expect(db.voice.findFirst).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
});

test.each(["pin", "recorded override", "persona"] as const)("unavailable configured %s refuses before dispatch without looking for another voice", async (source) => {
  if (source !== "pin") row.resolvedVoiceId = null;
  if (source === "recorded override") row.compiledSnapshot = { agent: { data: { voiceId: "voice" } } };
  if (source === "persona") row.agent.persona.voiceId = "voice";
  db.voice.findFirst.mockResolvedValue(null);
  await expect(connectVoice(input, session)).rejects.toMatchObject({ code: "voice_unavailable", status: 400 });
  expect(connect).not.toHaveBeenCalled();
  expect(db.voice.findFirst).toHaveBeenCalledTimes(1);
  expect(db.voice.findFirst.mock.calls[0][0].where).toMatchObject({ id: "voice", AND: [{ status: "ready", s3AudioKey: { not: "" }, OR: [{ orgId: "org" }, { orgId: null, kind: "sample" }] }] });
});

test("a missing sample default refuses instead of dispatching an unconfigured voice", async () => {
  row.resolvedVoiceId = null;
  db.voice.findMany.mockResolvedValue([]);
  await expect(connectVoice(input, session)).rejects.toMatchObject({ code: "voice_unavailable", status: 400 });
  expect(connect).not.toHaveBeenCalled();
  expect(row.resolvedVoiceId).toBeNull();
});

test("connectVoice scopes the session to its organization and owner before any voice resolution", async () => {
  db.interviewSession.findFirst.mockResolvedValue(null);
  await expect(connectVoice(input, session)).rejects.toMatchObject({ code: "not_found", status: 404 });
  expect(db.interviewSession.findFirst.mock.calls[0][0]).toMatchObject({ where: { id: "session", orgId: "org", OR: [{ userId: "learner" }, { userId: null, anonymousId: { not: null } }] } });
  expect(db.voice.findFirst).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
  expect(db.interviewSession.update).not.toHaveBeenCalled();
});

test("connectVoice refuses chat input before reading or changing a session", async () => {
  await expect(connectVoice({ ...input, mode: "chat" }, session)).rejects.toMatchObject({ code: "session_mode_mismatch", status: 409 });
  expect(db.interviewSession.findFirst).not.toHaveBeenCalled();
  expect(db.interviewSession.update).not.toHaveBeenCalled();
  expect(db.interviewSession.updateMany).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
});

test("connectVoice refuses a stored chat row before pinning, dispatch or failure cleanup", async () => {
  row.mode = "chat";
  row.resolvedVoiceId = null;
  await expect(connectVoice(input, session)).rejects.toMatchObject({ code: "session_mode_mismatch", status: 409 });
  expect(db.voice.findFirst).not.toHaveBeenCalled();
  expect(db.interviewSession.update).not.toHaveBeenCalled();
  expect(db.interviewSession.updateMany).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

test("connectVoice rechecks stored mode under the pin lock without failing a changed row", async () => {
  db.interviewSession.findFirst.mockResolvedValueOnce(row).mockResolvedValueOnce({ ...row, mode: "chat" });
  await expect(connectVoice(input, session)).rejects.toMatchObject({ code: "session_mode_mismatch", status: 409 });
  expect(db.voice.findFirst).not.toHaveBeenCalled();
  expect(db.interviewSession.update).not.toHaveBeenCalled();
  expect(db.interviewSession.updateMany).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

test("refusing a resumed call never closes or fails it", async () => {
  db.voice.findFirst.mockResolvedValue(null);
  await expect(connectVoice(input, { ...session, resumed: true })).rejects.toMatchObject({ code: "voice_unavailable" });
  expect(close).not.toHaveBeenCalled();
  expect(db.interviewSession.updateMany).not.toHaveBeenCalled();
});

test("connectVoice closes LiveKit and invalidates a failed session even if closing fails", async () => {
  const failed = db.interviewSession.updateMany;
  const error = new Error("dispatch failed");
  connect.mockRejectedValue(error);
  close.mockRejectedValue(new Error("room cleanup unavailable"));
  await expect(connectVoice(input, session)).rejects.toBe(error);
  expect(close).toHaveBeenCalledWith({ room: "old-room", dispatchId: "old-dispatch", videoEgressId: null });
  expect(failed).toHaveBeenCalledWith({ where: { id: "session", status: { in: ["activating", "active"] } }, data: { status: "failed", endedAt: expect.any(Date), runtimeTokenHash: null } });
});

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as activation from "@/lib/session-activation";
import { open, connect } from "@/workflows/steps/start-session";
import { startSession } from "@/workflows/start-session";

const input = { orgId: "org", userId: "learner", mode: "voice" as const };
const session = { id: "session", runtimeToken: "runtime" } as activation.OpenedSession;
let opening: ReturnType<typeof spyOn<typeof activation, "openSession">>;
let connecting: ReturnType<typeof spyOn<typeof activation, "connectVoice">>;
beforeEach(() => {
  opening = spyOn(activation, "openSession").mockResolvedValue({ ok: true, session });
  connecting = spyOn(activation, "connectVoice").mockResolvedValue({ participantToken: "participant", room: "room" });
});
afterEach(() => { opening.mockRestore(); connecting.mockRestore(); });

test("start-session steps never retry activation or agent dispatch", () => {
  expect(open.maxRetries).toBe(0);
  expect(connect.maxRetries).toBe(0);
});
test("voice opens first, then connects exactly once", async () => {
  expect(await startSession(input)).toEqual({ ok: true, session, participantToken: "participant", room: "room" });
  expect(opening).toHaveBeenCalledWith(input);
  expect(connecting).toHaveBeenCalledWith(input, session);
  expect(opening).toHaveBeenCalledTimes(1);
  expect(connecting).toHaveBeenCalledTimes(1);
  expect(opening.mock.invocationCallOrder[0]).toBeLessThan(connecting.mock.invocationCallOrder[0]);
});
test("chat skips connect and returns the runtime token as conversationToken", async () => {
  expect(await startSession({ ...input, mode: "chat" })).toEqual({ ok: true, session, conversationToken: "runtime" });
  expect(connecting).not.toHaveBeenCalled();
});
test("a refusal is returned unchanged without connecting", async () => {
  const refusal = { ok: false as const, status: 403, error: "Need minutes", code: "minutes" as const };
  opening.mockResolvedValue(refusal);
  expect(await startSession(input)).toBe(refusal);
  expect(connecting).not.toHaveBeenCalled();
});
test("unexpected open/connect errors reject without a second attempt", async () => {
  const error = new Error("unavailable");
  opening.mockRejectedValueOnce(error);
  await expect(startSession(input)).rejects.toBe(error);
  expect(connecting).not.toHaveBeenCalled();
  connecting.mockRejectedValueOnce(error);
  await expect(startSession(input)).rejects.toBe(error);
  expect(connecting).toHaveBeenCalledTimes(1);
});

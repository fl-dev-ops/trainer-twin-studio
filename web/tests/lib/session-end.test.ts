import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";

let row: { agent: { kind: string } } | null = { agent: { kind: "TWIN" } };
const start = mock(async (_workflow: unknown, _args: string[]) => ({ runId: "end-run" }));
const closeSessionRoom = mock(async (_id: string) => {});
const recordSessionUsage = mock(async (_id: string) => {});
const lookup = mock(async () => row);
const update = mock(async (_args: unknown) => ({}));
const endTwinSession = async () => {};
const endRoleplaySession = async () => {};
mock.module("workflow/api", () => ({ start }));
mock.module("@/lib/db", () => ({ db: { interviewSession: { findUnique: lookup, update } } }));
mock.module("@/lib/session-close", () => ({ closeSessionRoom }));
mock.module("@/lib/minutes", () => ({ recordSessionUsage }));
mock.module("@/workflows/end-twin-session", () => ({ endTwinSession }));
mock.module("@/workflows/end-roleplay-session", () => ({ endRoleplaySession }));
const { startSessionEnd } = await import("@/lib/session-end");
let errors: ReturnType<typeof spyOn<typeof console, "error">>;

beforeEach(() => {
  row = { agent: { kind: "TWIN" } };
  for (const fn of [start, closeSessionRoom, recordSessionUsage, lookup, update]) fn.mockClear();
  errors = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { errors.mockRestore(); });

test.each(["TWIN", "ROLEPLAY", "SCENARIO"])("%s starts the kind's end workflow, without inline room/charge work on success", async (kind) => {
  row = { agent: { kind } };
  await startSessionEnd("s1");
  expect(start).toHaveBeenCalledWith(kind === "TWIN" ? endTwinSession : endRoleplaySession, ["s1"]);
  expect(closeSessionRoom).not.toHaveBeenCalled();
  expect(recordSessionUsage).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
  expect(update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { endWorkAt: expect.any(Date) } });
  expect(start.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]);
});

test("missing sessions do not start anything", async () => {
  row = null;
  await startSessionEnd("missing");
  expect(start).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(closeSessionRoom).not.toHaveBeenCalled();
  expect(recordSessionUsage).not.toHaveBeenCalled();
});

test("start failure falls back to closing then charging and never throws", async () => {
  start.mockRejectedValueOnce(new Error("queue down"));
  await expect(startSessionEnd("s1")).resolves.toBeUndefined();
  expect(closeSessionRoom).toHaveBeenCalledWith("s1");
  expect(recordSessionUsage).toHaveBeenCalledWith("s1");
  expect(start.mock.invocationCallOrder[0]).toBeLessThan(closeSessionRoom.mock.invocationCallOrder[0]);
  expect(closeSessionRoom.mock.invocationCallOrder[0]).toBeLessThan(recordSessionUsage.mock.invocationCallOrder[0]);
  expect(update).not.toHaveBeenCalled();
  expect(errors).toHaveBeenCalledTimes(1);
  expect(errors.mock.calls[0]).toEqual([expect.stringContaining("workflow did not start"), "queue down"]);
});

test.each(["close", "charge", "both"])("start failure with %s failure still attempts both operations and logs without throwing", async (failure) => {
  start.mockRejectedValueOnce("queue down");
  if (failure !== "charge") closeSessionRoom.mockRejectedValueOnce(new Error("room down"));
  if (failure !== "close") recordSessionUsage.mockRejectedValueOnce(new Error("ledger down"));
  await expect(startSessionEnd("s1")).resolves.toBeUndefined();
  expect(closeSessionRoom).toHaveBeenCalledTimes(1);
  expect(recordSessionUsage).toHaveBeenCalledTimes(1);
  expect(errors).toHaveBeenCalledTimes(failure === "both" ? 3 : 2);
  const messages = errors.mock.calls.map(([message]) => message);
  if (failure !== "charge") expect(messages).toContainEqual(expect.stringContaining("closing the room failed"));
  if (failure !== "close") expect(messages).toContainEqual(expect.stringContaining("charging the call failed"));
});

test("lookup failure is caught before start, leaves endWorkAt empty and falls back without throwing", async () => {
  lookup.mockRejectedValueOnce(new Error("lookup unavailable"));
  await expect(startSessionEnd("s1")).resolves.toBeUndefined();
  expect(start).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  expect(closeSessionRoom).toHaveBeenCalledWith("s1"); expect(recordSessionUsage).toHaveBeenCalledWith("s1");
});

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as workflow from "workflow/api";
import * as activation from "@/lib/session-activation";
import { startSession } from "@/workflows/start-session";

const previousInterval = process.env.WORKFLOW_RETURN_VALUE_POLL_INTERVAL_MS;
delete process.env.WORKFLOW_RETURN_VALUE_POLL_INTERVAL_MS;
const { runSessionStart } = await import("@/lib/run-session-start");
const defaultInterval = process.env.WORKFLOW_RETURN_VALUE_POLL_INTERVAL_MS;
if (previousInterval === undefined) delete process.env.WORKFLOW_RETURN_VALUE_POLL_INTERVAL_MS;
else process.env.WORKFLOW_RETURN_VALUE_POLL_INTERVAL_MS = previousInterval;
const input = { orgId: "org", userId: "learner", mode: "chat" as const };
const refusal = { ok: false as const, status: 403, error: "Need minutes", code: "minutes" as const };
let start: ReturnType<typeof spyOn<typeof workflow, "start">>;
let fallback: ReturnType<typeof spyOn<typeof activation, "startSessionNow">>;
let log: ReturnType<typeof spyOn<typeof console, "error">>;
beforeEach(() => {
  start = spyOn(workflow, "start").mockResolvedValue({ returnValue: Promise.resolve(refusal) } as never);
  fallback = spyOn(activation, "startSessionNow").mockResolvedValue(refusal);
  log = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { start.mockRestore(); fallback.mockRestore(); log.mockRestore(); });

test("workflow return value polling defaults to 100ms", () => { expect(defaultInterval).toBe("100"); });
test("runSessionStart waits for the workflow return value, including refusals", async () => {
  let resolve!: (value: activation.SessionStart) => void;
  const returned = new Promise<activation.SessionStart>((done) => { resolve = done; });
  start.mockResolvedValue({ returnValue: returned } as never);
  let settled = false;
  const result = runSessionStart(input).then((value) => { settled = true; return value; });
  await new Promise((done) => setTimeout(done, 0));
  expect(settled).toBe(false);
  expect(start).toHaveBeenCalledWith(startSession, [input]);
  resolve(refusal);
  expect(await result).toEqual(refusal);
  expect(fallback).not.toHaveBeenCalled();
});
test("only a failed start falls back to direct activation", async () => {
  start.mockRejectedValue(new Error("queue down"));
  expect(await runSessionStart(input)).toEqual(refusal);
  expect(fallback).toHaveBeenCalledWith(input);
  expect(fallback).toHaveBeenCalledTimes(1);
});
test("a failed workflow return value propagates without opening a duplicate session", async () => {
  const error = new Error("connect failed");
  start.mockResolvedValue({ get returnValue() { return Promise.reject(error); } } as never);
  await expect(runSessionStart(input)).rejects.toBe(error);
  expect(fallback).not.toHaveBeenCalled();
});

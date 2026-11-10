import { beforeEach, expect, mock, test } from "bun:test";

// The old next/server after() scheduler is gone; the end workflow now owns these steps.
const closeSessionRoom = mock(async (_id: string) => {});
const recordSessionUsage = mock(async (_id: string) => {});
const generateSessionReport = mock(async (_id: string) => {});
const reportFor = mock(async (_id: string): Promise<"twin" | "roleplay" | "session" | null> => "session");
const claimReport = mock(async (_id: string, _runId: string) => true);
mock.module("@/lib/session-close", () => ({ closeSessionRoom, reportFor, claimReport }));
mock.module("@/lib/minutes", () => ({ recordSessionUsage }));
mock.module("@/lib/generate-session-report", () => ({ generateSessionReport }));
mock.module("workflow", () => ({ getWorkflowMetadata: () => ({ workflowRunId: "end-run-1" }) }));
const { closeRoom, chargeCall, takeReport, writeSessionReport } = await import("@/workflows/steps/session-end");

beforeEach(() => {
  for (const fn of [closeSessionRoom, recordSessionUsage, generateSessionReport, reportFor, claimReport]) fn.mockClear();
  reportFor.mockResolvedValue("session");
  claimReport.mockResolvedValue(true);
});

test("close and charge steps delegate the session id and propagate failures for retry", async () => {
  await closeRoom("s1");
  await chargeCall("s1");
  expect(closeSessionRoom).toHaveBeenCalledWith("s1");
  expect(recordSessionUsage).toHaveBeenCalledWith("s1");
  closeSessionRoom.mockRejectedValueOnce(new Error("LiveKit down"));
  recordSessionUsage.mockRejectedValueOnce(new Error("ledger down"));
  await expect(closeRoom("s1")).rejects.toThrow("LiveKit down");
  await expect(chargeCall("s1")).rejects.toThrow("ledger down");
});

test.each(["twin", "roleplay", "session"] as const)("takeReport claims %s for this end workflow's run", async (kind) => {
  reportFor.mockResolvedValue(kind);
  expect(await takeReport("s1")).toBe(kind);
  expect(claimReport).toHaveBeenCalledWith("s1", "end-run-1");
  expect(reportFor.mock.invocationCallOrder[0]).toBeLessThan(claimReport.mock.invocationCallOrder[0]);
});

test("takeReport returns null when another run already claimed it", async () => {
  claimReport.mockResolvedValue(false);
  expect(await takeReport("s1")).toBeNull();
});

test("takeReport does not claim ineligible sessions", async () => {
  reportFor.mockResolvedValue(null);
  expect(await takeReport("s1")).toBeNull();
  expect(claimReport).not.toHaveBeenCalled();
});

test("v1 reports are generated in a step with one retry, not an after() job", async () => {
  expect(writeSessionReport.maxRetries).toBe(1);
  await writeSessionReport("s1");
  expect(generateSessionReport).toHaveBeenCalledWith("s1");
  generateSessionReport.mockRejectedValueOnce(new Error("model down"));
  await expect(writeSessionReport("s1")).rejects.toThrow("model down");
});

import { beforeEach, expect, mock, test } from "bun:test";

process.env.AI_GATEWAY_API_KEY = "test-key";

let claimCount = 1;
let updates: Record<string, unknown>[] = [];
let manyUpdates: Record<string, unknown>[] = [];
let started: unknown[][] = [];
let startFails = false;
const session = {
  status: "completed",
  transcript: [{ role: "user", text: "How soon do I follow up?" }, { role: "trainer", text: "Same evening." }],
  evidence: { transcriptFinal: true },
  agent: { kind: "TWIN", name: "Olga's twin" },
  twinCalibration: null,
};

mock.module("@/lib/db", () => ({
  db: {
    interviewSession: {
      findUnique: async () => session,
      updateMany: async (args: Record<string, unknown>) => { manyUpdates.push(args); return { count: claimCount }; },
      update: async (args: Record<string, unknown>) => { updates.push(args); return {}; },
    },
  },
}));
// lib/usage is not mocked (Bun shares module mocks across files): meterUsage swallows its own errors.
mock.module("workflow/api", () => ({
  start: async (...args: unknown[]) => {
    if (startFails) throw new Error("queue down");
    started.push(args);
    return { runId: "wrun_1" };
  },
  getRun: () => ({ status: Promise.resolve("running") }),
}));

const { reportState } = await import("@/lib/twin/session-report");
const { scheduleTwinReport } = await import("@/lib/twin/schedule-report");
const { generateTwinReport } = await import("@/workflows/twin-session-report-steps");
const { FatalError, RetryableError } = await import("workflow");

const realFetch = globalThis.fetch;
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
};

beforeEach(() => {
  claimCount = 1;
  updates = [];
  manyUpdates = [];
  started = [];
  startFails = false;
  globalThis.fetch = realFetch;
});

test("report state: ready, being made, just ended, or not coming", () => {
  const now = Date.now();
  const report = { kind: "twin", summary: "", topics: [], questions: [], generatedAt: "x" };
  expect(reportState({ status: "completed", reportStatus: "completed", report, endedAt: new Date(now) }, now)).toBe("ready");
  expect(reportState({ status: "completed", reportStatus: "generating", report: null, endedAt: new Date(now) }, now)).toBe("pending");
  expect(reportState({ status: "completed", reportStatus: "none", report: null, endedAt: new Date(now - 60_000) }, now)).toBe("pending");
  expect(reportState({ status: "completed", reportStatus: "none", report: null, endedAt: new Date(now - 60 * 60_000) }, now)).toBe("unavailable");
  expect(reportState({ status: "completed", reportStatus: "failed", report: null, endedAt: new Date(now) }, now)).toBe("unavailable");
  expect(reportState({ status: "abandoned", reportStatus: "none", report: null, endedAt: new Date(now) }, now)).toBe("unavailable");
});

test("one run per claim; a lost claim starts nothing", async () => {
  expect(await scheduleTwinReport("s1")).toBe(true);
  expect(started).toHaveLength(1);
  expect(started[0][1]).toEqual(["s1"]);
  expect(updates).toEqual([{ where: { id: "s1" }, data: { reportWorkflowRunId: "wrun_1" } }]);

  claimCount = 0;
  expect(await scheduleTwinReport("s1")).toBe(false);
  expect(started).toHaveLength(1);
});

test("if the run cannot start, the claim is released so a later event can retry", async () => {
  startFails = true;
  await expect(scheduleTwinReport("s1")).rejects.toThrow("queue down");
  expect(manyUpdates.at(-1)).toEqual({ where: { id: "s1", reportStatus: "generating" }, data: { reportStatus: "failed" } });
});

test("generation step: rate limits wait, bad credentials stop, server errors retry, good replies parse", async () => {
  reply(429, {}, { "retry-after": "12" });
  const limited = await generateTwinReport("s1").catch((error: unknown) => error);
  expect(RetryableError.is(limited)).toBe(true);

  reply(401, { error: "bad key" });
  const unauthorized = await generateTwinReport("s1").catch((error: unknown) => error);
  expect(FatalError.is(unauthorized)).toBe(true);

  reply(503, { error: "busy" });
  const busy = await generateTwinReport("s1").catch((error: unknown) => error);
  expect(busy instanceof Error && !FatalError.is(busy) && !RetryableError.is(busy)).toBe(true);

  reply(200, { id: "gen_1", choices: [{ message: { content: JSON.stringify({ summary: "s", topics: ["Follow-up timing"], questions: ["How soon do I follow up?"] }) } }] });
  const report = await generateTwinReport("s1");
  expect(report.topics).toEqual(["Follow-up timing"]);
  expect(report.questions).toEqual(["How soon do I follow up?"]);
});

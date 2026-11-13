import { afterEach, expect, mock, test } from "bun:test";

process.env.AI_GATEWAY_API_KEY = "test-key";

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
    },
  },
}));
const { isTwinReport } = await import("@/lib/twin/session-report");
const { reportStateOf } = await import("@/lib/report-model");
const reportState = (row: Parameters<typeof reportStateOf>[0], now: number) => reportStateOf(row, isTwinReport, now);
const { generateTwinReport } = await import("@/workflows/steps/twin-session-report");
const { FatalError, RetryableError } = await import("workflow");

const realFetch = globalThis.fetch;
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
};

afterEach(() => { globalThis.fetch = realFetch; });

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

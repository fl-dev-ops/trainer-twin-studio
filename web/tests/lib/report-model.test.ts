import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";

process.env.AI_GATEWAY_API_KEY = "test-key";
mock.module("@/lib/usage", () => ({ chatCompletionItems: () => [], gatewayProvider: () => "gateway", meterUsage: async () => {} }));
const { callReportModel, reportStateOf, REPORT_STALE_MS } = await import("@/lib/report-model");
const { isTwinReport } = await import("@/lib/twin/session-report");
const { isSessionReport } = await import("@/lib/session-report");
const isRoleplayReport = (report: unknown) => isSessionReport(report) && "kind" in report && report.kind === "roleplay";
let fetching: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
beforeEach(() => { fetching = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content: "{}" } }] })); });
afterEach(() => { fetching.mockRestore(); });
const prompt = (user: string) => callReportModel({ sessionId: "s1", system: "Report only", user, schemaName: "test_report", schema: {} });
const sent = () => JSON.parse(String(fetching.mock.calls[0][1]!.body)) as { messages: { role: string; content: string }[] };

test.each([0, 119_999, 120_000])("report prompt of %s characters is unchanged", async (length) => {
  const user = "x".repeat(length); await prompt(user);
  expect(sent().messages).toEqual([{ role: "system", content: "Report only" }, { role: "user", content: user }]);
});
test("long report prompt keeps its most recent part, labelled, within 120,000 characters", async () => {
  const tail = `${"t".repeat(119_960)}LAST WORDS`;
  await prompt(`earlier opening${"e".repeat(100)}${tail}`);
  expect(sent().messages[1].content).toEndWith(tail);
  expect(sent().messages[1].content).not.toContain("earlier opening");
  expect(sent().messages[1].content).toStartWith("[…earlier part cut]\n");
});
test("the report prompt cap includes the cut label (at most 120,000 characters)", async () => {
  await prompt("x".repeat(120_001));
  expect(sent().messages[1].content.length).toBeLessThanOrEqual(120_000);
});
test.each(["twin", "roleplay"])("shared reportStateOf makes stale %s reports unavailable while ready reports stay ready", (kind) => {
  const now = 1_800_000_000_000;
  const ready = kind === "twin" ? isTwinReport : isRoleplayReport;
  const row = { status: "completed", reportStatus: "generating", report: null, endedAt: new Date(now - REPORT_STALE_MS + 1) };
  expect(reportStateOf(row, ready, now)).toBe("pending");
  expect(reportStateOf({ ...row, endedAt: new Date(now - REPORT_STALE_MS) }, ready, now)).toBe("unavailable");
  const report = kind === "twin" ? { kind, summary: "s", topics: [], questions: [], generatedAt: "x" } : { kind, summary: "s", summaryTags: [], keyMoments: [], focusNextTime: "f", generatedAt: "x" };
  expect(reportStateOf({ ...row, report, endedAt: new Date(now - REPORT_STALE_MS - 1) }, ready, now)).toBe("ready");
  expect(reportStateOf({ ...row, reportStatus: "none", endedAt: new Date(now - 9 * 60_000) }, ready, now)).toBe("pending");
  expect(reportStateOf({ ...row, reportStatus: "none", endedAt: new Date(now - 10 * 60_000) }, ready, now)).toBe("unavailable");
  expect(reportStateOf({ ...row, status: "abandoned", reportStatus: "none" }, ready, now)).toBe("unavailable");
  expect(reportStateOf({ ...row, reportStatus: "failed" }, ready, now)).toBe("unavailable");
});

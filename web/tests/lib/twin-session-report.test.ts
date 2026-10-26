import { beforeEach, expect, mock, test } from "bun:test";

type Row = { agent: { kind: string }; twinCalibration: { id: string } | null };
let rows: Record<string, Row> = {};
let claims: string[] = [];
let roleplayScheduled: string[] = [];

mock.module("@/lib/db", () => ({
  db: {
    interviewSession: {
      findUnique: async ({ where }: { where: { id: string } }) => rows[where.id] ?? null,
      // Claim lost (count 0) so the twin path stops before after(); the call itself proves the route.
      updateMany: async ({ where }: { where: { id: string } }) => { claims.push(where.id); return { count: 0 }; },
    },
  },
}));
mock.module("@/lib/session-report-jobs", () => ({
  scheduleSessionReport: async (id: string) => { roleplayScheduled.push(id); return true; },
}));

const { processCompletedSession } = await import("@/lib/session-processing");
const { isTwinReport, toTwinReport } = await import("@/lib/twin/session-report");
const { mostAsked } = await import("@/lib/twin/stats");

beforeEach(() => { rows = {}; claims = []; roleplayScheduled = []; });

test("completed sessions go to the report for their kind; calibrations get none", async () => {
  rows = {
    rp: { agent: { kind: "ROLEPLAY" }, twinCalibration: null },
    tw: { agent: { kind: "TWIN" }, twinCalibration: null },
    cal: { agent: { kind: "TWIN" }, twinCalibration: { id: "c1" } },
  };
  await processCompletedSession("rp");
  await processCompletedSession("tw");
  await processCompletedSession("cal");
  expect(await processCompletedSession("missing")).toBe(false);
  expect(roleplayScheduled).toEqual(["rp"]);
  expect(claims).toEqual(["tw"]);
});

test("model reply becomes a twin report: trimmed, empties dropped, capped", () => {
  const report = toTwinReport(
    JSON.stringify({
      summary: " Asked about a quiet client. ",
      topics: [" Follow-up timing ", "", "a", "b", "c", "d"],
      questions: ["How soon do I follow up?", " ", "q2", "q3", "q4", "q5", "q6"],
    }),
    new Date("2026-10-27T00:00:00Z"),
  );
  expect(report).toEqual({
    kind: "twin",
    summary: "Asked about a quiet client.",
    topics: ["Follow-up timing", "a", "b", "c"],
    questions: ["How soon do I follow up?", "q2", "q3", "q4", "q5"],
    generatedAt: "2026-10-27T00:00:00.000Z",
  });
  expect(isTwinReport(report)).toBe(true);
  expect(() => toTwinReport("{\"summary\":1}")).toThrow();
});

test("roleplay reports are not twin reports", () => {
  expect(isTwinReport({ summary: "s", summaryTags: [], keyMoments: [], focusNextTime: "f" })).toBe(false);
  expect(isTwinReport(null)).toBe(false);
});

test("most asked counts each question once per session, case/space-insensitive, top 3", () => {
  expect(
    mostAsked([
      ["How do I price?", "What next?"],
      ["how do I  price?", "How do I price?"],
      ["What next?", "Why?"],
      ["How do I price?", "Other"],
    ]),
  ).toEqual([
    { question: "How do I price?", count: 3 },
    { question: "What next?", count: 2 },
    { question: "Why?", count: 1 },
  ]);
});

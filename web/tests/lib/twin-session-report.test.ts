import { beforeEach, expect, mock, test } from "bun:test";

type Row = { agent: { kind: string; data?: unknown; name?: string }; twinCalibration: { id: string } | null; transcript?: unknown; status?: string; evidence?: unknown };
let rows: Record<string, Row> = {};

mock.module("@/lib/db", () => ({
  db: {
    interviewSession: {
      findUnique: async ({ where }: { where: { id: string } }) => rows[where.id] ?? null,
    },
  },
}));
const { reportFor } = await import("@/lib/session-close");
const { reportKindOf } = await import("@/lib/session-after");
const { isTwinReport, loadTwinReportInput, toTwinReport } = await import("@/lib/twin/session-report");
const { mostAsked } = await import("@/lib/twin/stats");

beforeEach(() => { rows = {}; });

test("completed sessions get the report for their kind; calibrations and missing sessions get none", async () => {
  rows = {
    rp: { status: "completed", agent: { kind: "ROLEPLAY" }, twinCalibration: null },
    tw: { status: "completed", agent: { kind: "TWIN" }, twinCalibration: null },
    cal: { status: "completed", agent: { kind: "TWIN" }, twinCalibration: { id: "c1" } },
  };
  expect(await reportFor("rp")).toBe("session");
  expect(await reportFor("tw")).toBe("twin");
  expect(await reportFor("cal")).toBeNull();
  expect(await reportFor("missing")).toBeNull();
});

test("after.report decides the processing; without it twins get the twin report, others the session report", async () => {
  expect(reportKindOf({}, "TWIN")).toBe("twin");
  expect(reportKindOf({}, "ROLEPLAY")).toBe("session");
  expect(reportKindOf({ after: { report: "roleplay" } }, "ROLEPLAY")).toBe("roleplay");
  expect(reportKindOf({ after: { report: "nonsense" } }, "ROLEPLAY")).toBe("session");
  rows = { rp2: { status: "completed", agent: { kind: "ROLEPLAY", data: { after: { report: "roleplay" } } }, twinCalibration: null } };
  expect(await reportFor("rp2")).toBe("roleplay");
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
    unanswered: [], // left out by the model: an empty list, not a failed report
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

test("an abandoned twin learner call gets its report when the learner spoke; nothing else that didn't complete does", async () => {
  const talked = [{ role: "trainer", text: "Hi, what's going on with your client?" }, { role: "user", text: "He wants to wait for prices to drop." }];
  rows = {
    spoke: { status: "abandoned", agent: { kind: "TWIN" }, twinCalibration: null, transcript: talked },
    silent: { status: "abandoned", agent: { kind: "TWIN" }, twinCalibration: null, transcript: [{ role: "trainer", text: "Hi?" }] },
    cal: { status: "abandoned", agent: { kind: "TWIN" }, twinCalibration: { id: "c1" }, transcript: talked },
    rp: { status: "abandoned", agent: { kind: "ROLEPLAY", data: { after: { report: "roleplay" } } }, twinCalibration: null, transcript: talked },
    v1: { status: "abandoned", agent: { kind: "ROLEPLAY", data: {} }, twinCalibration: null, transcript: talked },
  };
  expect(await reportFor("spoke")).toBe("twin");
  for (const id of ["silent", "cal", "rp", "v1"]) expect(await reportFor(id)).toBeNull();
});

test.each(["active", "activating", "failed", "revoked", "assigned"])("%s sessions get no report even with learner speech", async (status) => {
  rows = { tw: { status, agent: { kind: "TWIN" }, twinCalibration: null, transcript: [{ role: "user", text: "Hello" }] } };
  expect(await reportFor("tw")).toBeNull();
});

test("report eligibility: completed, or abandoned after the learner spoke; never a calibration", async () => {
  const talked = [{ role: "trainer", text: "Hi" }, { role: "user", text: "My client went quiet." }];
  rows = {
    done: { status: "completed", agent: { kind: "TWIN" }, twinCalibration: null, transcript: [] },
    dropped: { status: "abandoned", agent: { kind: "TWIN" }, twinCalibration: null, transcript: talked },
    silent: { status: "abandoned", agent: { kind: "TWIN" }, twinCalibration: null, transcript: [{ role: "trainer", text: "Hi" }] },
    failed: { status: "failed", agent: { kind: "TWIN" }, twinCalibration: null, transcript: talked },
    cal: { status: "completed", agent: { kind: "TWIN" }, twinCalibration: { id: "c1" }, transcript: talked },
  };
  const eligible = async (id: string) => (await loadTwinReportInput(id)).eligible;
  expect(await eligible("done")).toBe(true);
  expect(await eligible("dropped")).toBe(true);
  expect(await eligible("silent")).toBe(false);
  expect(await eligible("failed")).toBe(false);
  expect(await eligible("cal")).toBe(false);
});

test("the questions the twin declined are kept (trimmed, capped); reports from before still count as twin reports", () => {
  const report = toTwinReport(JSON.stringify({
    summary: "s", topics: ["Cold calling"], questions: ["How do I open a cold call?"],
    unanswered: [" How do I open a cold call? ", "", "u2", "u3", "u4", "u5", "u6"],
  }));
  expect(report.unanswered).toEqual(["How do I open a cold call?", "u2", "u3", "u4", "u5"]);
  expect(isTwinReport({ kind: "twin", summary: "s", topics: [], questions: [], generatedAt: "2026-11-01T00:00:00.000Z" })).toBe(true);
});

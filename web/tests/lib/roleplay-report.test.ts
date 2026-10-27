import { expect, mock, test } from "bun:test";

let row: Record<string, unknown> | null = null;
mock.module("@/lib/db", () => ({ db: { interviewSession: { findUnique: async () => row } } }));

const { buildRoleplayReport, loadRoleplayReportInput, roleplayAfterOf, toRoleplayReport } = await import("@/lib/roleplay/session-report");
const { ReportError } = await import("@/lib/report-model");

const after = {
  goals: ["Acknowledge the concern", "Book a follow-up"],
  rubric: [{ name: "Calm tone", points: 40 }, { name: "Dated follow-up", points: 60 }],
};

test("goals and rubric come from data.after; bad rows skipped, limits applied", () => {
  expect(roleplayAfterOf({})).toEqual({ goals: [], rubric: [] });
  const parsed = roleplayAfterOf({
    after: {
      goals: [" One ", "", 3, "Two", "Three", "Four", "Five", "Six"],
      rubric: [{ name: "Tone", points: 20 }, { name: "", points: 10 }, { name: "Half", points: 2.5 }, { name: "Big", points: 101 }],
    },
  });
  expect(parsed.goals).toEqual(["One", "Two", "Three", "Four", "Five"]);
  expect(parsed.rubric).toEqual([{ name: "Tone", points: 20 }]);
});

test("model reply is aligned to the configuration: goal order, clamped points, score from the rubric", () => {
  const report = toRoleplayReport("s1", JSON.stringify({
    summary: "Stayed calm, no date.",
    summaryTags: ["Waiting"],
    keyMoments: [{ number: "01", timestamp: "1:00", seconds: 60, title: "Calm", quote: "I hear you", description: "Good" }],
    focusNextTime: "Ask for a date.",
    score: 99,
    goalResults: [{ goal: "book a follow-up", status: "met", evidence: "Booked Tuesday" }, { goal: "x", status: "bogus", evidence: 1 }],
    rubricScores: [{ criterion: "Dated follow-up", points: 75, reason: "Clamped" }, { criterion: "Calm tone", points: 30, reason: "Fine" }],
  }), after, new Date("2026-10-27T00:00:00Z"));
  expect(report.kind).toBe("roleplay");
  expect(report.goalResults).toEqual([
    { goal: "Acknowledge the concern", status: "not_met", evidence: "" },
    { goal: "Book a follow-up", status: "met", evidence: "Booked Tuesday" },
  ]);
  expect(report.rubricScores?.map((r) => [r.criterion, r.points, r.maxPoints])).toEqual([["Calm tone", 30, 40], ["Dated follow-up", 60, 60]]);
  expect(report.score).toBe(90); // (30 + 60) / 100, not the model's 99
  expect(report.keyMoments[0].id).toBe("s1-m1");
  expect(() => toRoleplayReport("s1", "{}", after)).toThrow();
  // Rows without usable names fall back to their position.
  const unnamed = toRoleplayReport("s1", { summary: "", summaryTags: [], keyMoments: [], focusNextTime: "", rubricScores: [{ points: 10 }, { points: 20 }] }, after);
  expect(unnamed.rubricScores?.map((r) => r.points)).toEqual([10, 20]);
});

test("input: only completed role plays with after.report = roleplay; the pinned snapshot wins over the live agent", async () => {
  row = {
    status: "completed",
    transcript: [{ role: "assistant", text: "Hello?" }, { role: "user", text: "Hi, it's Sam" }],
    evidence: { transcriptFinal: true },
    compiledSnapshot: {
      agent: { data: { after: { report: "roleplay", goals: ["Pinned goal"] }, skill: "---\nname: x\n---\n## Situation\nBuyer waiting.", scenario: { learner_role: "Agent" } } },
      persona: { data: { name: "Daniel", role: "Investor", background: "Cautious" } },
    },
    agent: { kind: "ROLEPLAY", name: "Wait-and-see", data: { after: { report: "roleplay", goals: ["Live goal"] } } },
  };
  const input = await loadRoleplayReportInput("s1");
  expect(input.eligible).toBe(true);
  expect(input.transcriptFinal).toBe(true);
  expect(input.goals).toEqual(["Pinned goal"]);
  expect(input.turns.map((t) => t.who)).toEqual(["twin", "learner"]);
  expect(input.brief).toContain("Client: Daniel, Investor");
  expect(input.brief).toContain("## Situation\nBuyer waiting.");
  expect(input.brief).not.toContain("name: x");

  row = { ...row, compiledSnapshot: null, agent: { kind: "ROLEPLAY", name: "Legacy", data: {} } };
  expect((await loadRoleplayReportInput("s1")).eligible).toBe(false);
  row = { ...row, status: "abandoned", agent: { kind: "ROLEPLAY", name: "x", data: { after: { report: "roleplay" } } } };
  expect((await loadRoleplayReportInput("s1")).eligible).toBe(false);
});

test("no transcript is fatal; a silent learner gets an empty, all-missed report without a model call", async () => {
  const base = { agentName: "x", brief: "", ...after };
  await expect(buildRoleplayReport("s1", { ...base, turns: [] })).rejects.toBeInstanceOf(ReportError);
  const silent = await buildRoleplayReport("s1", { ...base, turns: [{ who: "twin", text: "Hello?" }] });
  expect(silent.score).toBe(0);
  expect(silent.goalResults?.every((g) => g.status === "not_met")).toBe(true);
  expect(silent.rubricScores?.every((r) => r.points === 0)).toBe(true);
});

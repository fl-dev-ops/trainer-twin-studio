import assert from "node:assert/strict";
import test from "node:test";
import { summarizeToolInput, summarizeToolOutput } from "../../../agent/lib/tool-trace";

test("session_plan keeps the decision fields and drops claim text", () => {
  assert.deepEqual(
    summarizeToolInput("session_plan", { action: "record_answer", answerStatus: "partial", evidenceUpdates: { ownership: "partial" } }),
    { action: "record_answer", answerStatus: "partial", evidenceUpdates: ["ownership"] },
  );
  const output = summarizeToolOutput("session_plan", {
    nextAction: { kind: "pose_main_question", questionType: "resume" },
    activeQuestion: { id: "q2", type: "resume", followUpsRemaining: 2 },
    totalTurnsUsed: 4,
    resumeClaimCandidates: [{ claimId: "c1", text: "Led the payments rewrite at Acme" }, { claimId: "c2", text: "..." }],
  });
  assert.deepEqual(output, {
    nextAction: "pose_main_question",
    nextQuestionType: "resume",
    activeQuestionId: "q2",
    followUpsRemaining: 2,
    totalTurnsUsed: 4,
    resumeClaimCandidates: ["c1", "c2"],
  });
  assert.ok(!JSON.stringify(output).includes("payments rewrite"));
  assert.ok(!JSON.stringify(summarizeToolInput("session_plan", { reply: "Private learner feedback" })).includes("Private learner feedback"));
});

test("other tools and errors never include free-text prefixes", () => {
  assert.deepEqual(
    summarizeToolInput("search_knowledge", { query: "Private learner answer", limit: 3 }),
    { query: "string", limit: "number" },
  );
  assert.deepEqual(summarizeToolOutput("search_knowledge", { error: "Private learner answer" }), { error: true });
});

test("statuses, wrapped outputs and errors", () => {
  assert.deepEqual(summarizeToolOutput("start_resume_question", { status: "highlighted" }), { status: "highlighted" });
  assert.deepEqual(
    summarizeToolOutput("start_resume_question", { status: "highlighted", nextAction: { kind: "pose_main_question" } }),
    { status: "highlighted", nextAction: "pose_main_question" },
  );
  assert.deepEqual(summarizeToolOutput("start_resume_question", { type: "json", value: { status: "not_found" } }), { status: "not_found" });
  assert.deepEqual(summarizeToolOutput("start_resume_question", null, true), { error: true });
  assert.deepEqual(
    summarizeToolInput("start_resume_question", { claimId: "c1", question: "What did you build at Private Company?" }),
    { claimId: "c1", answerStatus: null, evidenceUpdates: [] },
  );
});

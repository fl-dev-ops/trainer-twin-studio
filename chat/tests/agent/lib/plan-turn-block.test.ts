import assert from "node:assert/strict";
import test from "node:test";
import { followUpGradesForState, formatPlanTurnBlock, outcomesByGrade } from "../../../agent/lib/plan-turn-block";
import { advanceSessionPlan, compileSessionPlan } from "../../../agent/lib/session-plan";

function resumePlan() {
  return compileSessionPlan({
    config: { interview: { type: "resume" as const, main_questions: 2, follow_ups_per_main_question: 2 }, turns: { maximum: 12 } },
    stages: [{ id: "project-deep-dive", name: "Project Deep Dive", config: { turns: { minimum: 2, maximum: 12 } } }],
  });
}

const claim = { claimId: "c7", section: "Experience", text: "Built a dual-mode SIM replacement platform\nfor 2M users" };

test("predicts the plan's next action for every grade without changing the real plan", () => {
  const state = resumePlan();
  const before = JSON.stringify(state);
  const outcomes = outcomesByGrade(state);
  assert.equal(outcomes.strong, "pose_main_question (resume)");
  assert.equal(outcomes.partial, "ask_follow_up (resume)");
  assert.equal(JSON.stringify(state), before);
});

test("follow-up state: one-call rule plus claims for the strong-answer path", () => {
  const block = formatPlanTurnBlock(resumePlan(), [claim]);
  assert.ok(block);
  assert.match(block, /follow-ups remaining: 2/);
  assert.match(block, /- partial → ask_follow_up \(resume\)/);
  assert.match(block, /ONE-CALL RULE/);
  assert.match(block, /`reply` is exactly what you say/);
  assert.match(block, /make ONE tool call, `start_resume_question\(\{ claimId, question, answerStatus, evidenceUpdates \}\)`/);
  assert.match(block, /claimId c7 \[Experience\]: Built a dual-mode SIM replacement platform for 2M users/);
});

test("last follow-up used: every grade moves on to a new main question", () => {
  let state = resumePlan();
  for (let i = 0; i < 2; i += 1) state = advanceSessionPlan(state, { type: "record_answer", answerStatus: "partial" }).state;
  const outcomes = outcomesByGrade(state);
  assert.ok(Object.values(outcomes).every((outcome) => outcome === "pose_main_question (resume)"));
  const block = formatPlanTurnBlock(state, [claim])!;
  assert.match(block, /the next step is a new main question whatever your grade/);
  assert.match(block, /Do NOT call session_plan first\./);
  assert.doesNotMatch(block, /allowed ONLY if your grade/);
  const withoutClaims = formatPlanTurnBlock(state, [])!;
  assert.match(withoutClaims, /No cached resume claim candidates/);
  assert.doesNotMatch(withoutClaims, /Do NOT call session_plan first/);
});

test("no block before the plan exists; a confirmation block while closing; none once confirmed", () => {
  assert.equal(formatPlanTurnBlock(null, [claim]), null);
  const confirming = formatPlanTurnBlock({ ...resumePlan(), closingState: "awaiting_confirmation" as const }, [claim])!;
  assert.match(confirming, /reply in plain text only \(no tool calls\)/);
  assert.match(confirming, /session_plan\(\{ action: "confirm_end" \}\), then finish_session\(\) — with NO spoken output/);
  assert.equal(formatPlanTurnBlock({ ...resumePlan(), closingState: "confirmed" as const }, [claim]), null);
});

test("states exactly which grades allow a new question this turn", () => {
  const block = formatPlanTurnBlock(resumePlan(), [claim])!;
  assert.match(block, /THIS TURN: start_resume_question is allowed ONLY if your grade is: strong\./);
  assert.match(block, /For partial, vague, contradictory, unknown: ask a follow-up with session_plan \+ reply/);
});

test("publishes which grades lead to a follow-up, shared through globalThis", async () => {
  const { followUpGradesForState } = await import("../../../agent/lib/plan-turn-block");
  const { followUpGradesFor, publishTurnGrades } = await import("../../../agent/lib/turn-grades");
  assert.deepEqual(followUpGradesForState(resumePlan()), ["partial", "vague", "contradictory", "unknown"]);
  assert.deepEqual(followUpGradesForState(null), []);
  publishTurnGrades("s-grades", ["partial"]);
  assert.deepEqual(followUpGradesFor("s-grades"), ["partial"]);
  assert.equal(followUpGradesFor("s-missing"), null);
  publishTurnGrades("s-grades", null);
  assert.equal(followUpGradesFor("s-grades"), null);
});

test("an unfinished learner turn is not graded: invite them to continue in plain text", () => {
  const block = formatPlanTurnBlock(resumePlan(), [claim])!;
  assert.match(block, /INCOMPLETE-ANSWER RULE — check this FIRST/);
  assert.match(block, /do NOT grade it, do NOT call session_plan or start_resume_question/);
  assert.match(block, /This rule overrides everything below, including THIS TURN\./);
  assert.ok(block.indexOf("INCOMPLETE-ANSWER RULE") < block.indexOf("ONE-CALL RULE"));
});

test("last question: closing is one call, the closing reply is allowed, closing style is offered", () => {
  let state = resumePlan();
  state = advanceSessionPlan(state, { type: "record_answer", answerStatus: "strong" }).state; // -> question 2 (last)
  state = advanceSessionPlan(state, { type: "record_answer", answerStatus: "partial" }).state;
  state = advanceSessionPlan(state, { type: "record_answer", answerStatus: "partial" }).state; // follow-ups used up
  const style = { closing: ["does: feedback -> ask to end"] };
  const block = formatPlanTurnBlock(state, [], style)!;
  assert.match(block, /If your grade leads to start_closing: call `session_plan\(\{ action: "record_answer"/);
  assert.match(block, /the interview ends after this answer/);
  assert.match(block, /- \[closing\] does: feedback -> ask to end/);
  assert.deepEqual(followUpGradesForState(state), ["strong", "partial", "vague", "contradictory", "unknown"]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { advanceSessionPlan, answerAlreadyRecorded, compileSessionPlan, moveToNextMainQuestion, recordAnswerOnce, summarizeSessionPlan } from "../../../agent/lib/session-plan";

function technicalAgent() {
  return {
    config: {
      interview: {
        type: "technical" as const,
        question_counts: { verbal: 2, mcq: 1, "code-output": 2 },
        follow_ups_per_main_question: 2,
      },
      turns: { maximum: 12 },
    },
    stages: [{
      id: "fundamental-knowledge",
      name: "Fundamental Knowledge",
      config: {
        turns: { minimum: 6, maximum: 12 },
        evidence: {
          keys: ["concept_explanation", "mechanism_walkthrough"],
          completion_keys: ["concept_explanation", "mechanism_walkthrough"],
        },
      },
    }],
  };
}

test("compiles mixed technical quotas into typed TODOs", () => {
  const plan = compileSessionPlan(technicalAgent());
  assert.deepEqual(plan.rounds[0].questions.map(({ type }) => type), [
    "verbal",
    "verbal",
    "mcq",
    "code-output",
    "code-output",
  ]);
  assert.equal(plan.rounds[0].minimumTurns, 6);
  assert.equal(plan.rounds[0].maximumTurns, 12);
  assert.equal(summarizeSessionPlan(plan).nextAction.kind, "pose_main_question");
});

test("allocates session question quotas exactly once across stages", () => {
  const agent: any = technicalAgent();
  agent.stages.push({
    id: "second-round",
    name: "Second Round",
    config: { turns: { minimum: 0, maximum: 12 }, evidence: { keys: [], completion_keys: [] } },
  });
  const plan = compileSessionPlan(agent);
  assert.equal(plan.rounds.flatMap(({ questions }) => questions).length, 5);
  assert.deepEqual(plan.rounds.map(({ questions }) => questions.length), [3, 2]);
});

test("advances to the next stage before closing", () => {
  const agent: any = technicalAgent();
  agent.config.interview.question_counts = { verbal: 2 };
  agent.config.interview.follow_ups_per_main_question = 0;
  agent.stages[0].config.turns = { minimum: 1, maximum: 2 };
  agent.stages[0].config.evidence.completion_keys = [];
  agent.stages.push({
    id: "second-round",
    name: "Second Round",
    config: { turns: { minimum: 1, maximum: 2 }, evidence: { keys: [], completion_keys: [] } },
  });
  const plan = compileSessionPlan(agent);

  const result = advanceSessionPlan(plan, { type: "record_answer", answerStatus: "strong" });
  assert.equal(plan.rounds[0].status, "done");
  assert.equal(plan.currentRound, 1);
  assert.equal(result.nextAction.kind, "pose_main_question");
});

test("uses follow-ups adaptively and advances after a strong answer", () => {
  const plan = compileSessionPlan(technicalAgent());
  assert.equal(summarizeSessionPlan(plan).nextAction.kind, "pose_main_question");
  assert.equal(plan.rounds[0].turnsUsed, 1);

  advanceSessionPlan(plan, {
    type: "record_answer",
    answerStatus: "partial",
    evidenceUpdates: { concept_explanation: "partial" },
  });
  assert.equal(summarizeSessionPlan(plan).nextAction.kind, "ask_follow_up");
  assert.equal(plan.rounds[0].questions[0].followUpsUsed, 1);

  advanceSessionPlan(plan, {
    type: "record_answer",
    answerStatus: "strong",
    evidenceUpdates: { concept_explanation: "sufficient" },
  });
  assert.equal(plan.rounds[0].questions[0].status, "done");
  assert.equal(plan.rounds[0].questions[1].status, "active");
  assert.equal(summarizeSessionPlan(plan).nextAction.kind, "pose_main_question");
});

test("does not accept sufficient evidence from a non-strong answer", () => {
  const plan = compileSessionPlan(technicalAgent());

  advanceSessionPlan(plan, {
    type: "record_answer",
    answerStatus: "vague",
    evidenceUpdates: { concept_explanation: "sufficient" },
  });

  assert.equal(plan.rounds[0].evidence.concept_explanation, "partial");
  assert.equal(summarizeSessionPlan(plan).nextAction.kind, "ask_follow_up");
});

test("does not downgrade evidence once sufficient", () => {
  const plan = compileSessionPlan(technicalAgent());

  advanceSessionPlan(plan, {
    type: "record_answer",
    answerStatus: "strong",
    evidenceUpdates: { concept_explanation: "sufficient" },
  });
  assert.equal(plan.rounds[0].evidence.concept_explanation, "sufficient");

  advanceSessionPlan(plan, {
    type: "record_answer",
    answerStatus: "partial",
    evidenceUpdates: { concept_explanation: "partial" },
  });
  assert.equal(plan.rounds[0].evidence.concept_explanation, "sufficient");
});

test("uses remaining follow-up budget to close evidence gaps", () => {
  const agent: any = technicalAgent();
  agent.config.interview.question_counts = { verbal: 1 };
  agent.config.interview.follow_ups_per_main_question = 1;
  agent.stages[0].config.turns = { minimum: 1, maximum: 3 };
  const plan = compileSessionPlan(agent);

  advanceSessionPlan(plan, { type: "record_answer", answerStatus: "strong" });
  assert.equal(summarizeSessionPlan(plan).nextAction.kind, "ask_follow_up");

  advanceSessionPlan(plan, {
    type: "record_answer",
    answerStatus: "strong",
    evidenceUpdates: {
      concept_explanation: "sufficient",
      mechanism_walkthrough: "sufficient",
    },
  });
  assert.equal(summarizeSessionPlan(plan).nextAction.kind, "start_closing");
});

test("closing state prevents interview questions and requires confirmation", () => {
  const agent: any = technicalAgent();
  agent.config.interview.question_counts = { verbal: 1 };
  agent.config.interview.follow_ups_per_main_question = 0;
  agent.stages[0].config.turns = { minimum: 1, maximum: 1 };
  agent.stages[0].config.evidence.completion_keys = [];
  const plan = compileSessionPlan(agent);

  advanceSessionPlan(plan, { type: "record_answer", answerStatus: "strong" });
  advanceSessionPlan(plan, { type: "start_closing" });
  assert.equal(summarizeSessionPlan(plan).nextAction.kind, "await_confirmation");

  advanceSessionPlan(plan, { type: "learner_question_during_closing" });
  assert.equal(summarizeSessionPlan(plan).nextAction.kind, "await_confirmation");
  advanceSessionPlan(plan, { type: "confirm_end" });
  assert.equal(summarizeSessionPlan(plan).nextAction.kind, "finish_session");
});

test("an answer recorded in a turn cannot be recorded again in the same turn", () => {
  const state = { ...compileSessionPlan(technicalAgent()), lastRecordedTurnId: "turn-7" };
  assert.equal(answerAlreadyRecorded(state, "turn-7"), true);
  assert.equal(answerAlreadyRecorded(state, "turn-8"), false);
  assert.equal(answerAlreadyRecorded(state, undefined), false);
  assert.equal(answerAlreadyRecorded(compileSessionPlan(technicalAgent()), "turn-7"), false);
});

test("recordAnswerOnce advances the plan once per turn, whichever tool records", () => {
  const first = recordAnswerOnce(compileSessionPlan(technicalAgent()), { answerStatus: "partial" }, "turn-3");
  assert.equal(first.alreadyRecorded, false);
  assert.equal(first.state.lastRecordedTurnId, "turn-3");
  const again = recordAnswerOnce(first.state, { answerStatus: "partial" }, "turn-3");
  assert.equal(again.alreadyRecorded, true);
  assert.equal(again.state, first.state);
  assert.equal(recordAnswerOnce(first.state, { answerStatus: "partial" }, "turn-4").alreadyRecorded, false);
});

function resumeAgent() {
  return {
    config: { interview: { type: "resume" as const, main_questions: 2, follow_ups_per_main_question: 2 }, turns: { maximum: 12 } },
    stages: [{ id: "deep-dive", name: "Deep Dive", config: { turns: { minimum: 2, maximum: 12 } } }],
  };
}

const answer = (state: ReturnType<typeof compileSessionPlan>, answerStatus: "unknown" | "partial" | "strong") =>
  advanceSessionPlan(state, { type: "record_answer", answerStatus });

test("first 'I don't know' gets one follow-up; a second in a row moves to the next question", () => {
  const first = answer(compileSessionPlan(resumeAgent()), "unknown");
  assert.equal(first.nextAction.kind, "ask_follow_up");
  assert.equal(summarizeSessionPlan(first.state).activeQuestion?.id, "deep-dive:resume:1");

  const second = answer(first.state, "unknown");
  assert.equal(second.nextAction.kind, "pose_main_question");
  assert.equal(summarizeSessionPlan(second.state).activeQuestion?.id, "deep-dive:resume:2");
});

test("a real answer in between resets the 'I don't know' streak", () => {
  let state = answer(compileSessionPlan(resumeAgent()), "unknown").state;
  state = answer(state, "partial").state;
  const afterReset = answer(state, "unknown");
  // follow-ups are now used up, so the plan moves on because of the quota, not the streak
  assert.equal(afterReset.nextAction.kind, "pose_main_question");
  const question = afterReset.state.rounds[0].questions[0];
  assert.equal(question.unknownStreak, 1);
});

test("two 'I don't know' answers on the last question close instead of probing it again", () => {
  let state = answer(compileSessionPlan(resumeAgent()), "strong").state;
  state = answer(state, "unknown").state;
  const result = answer(state, "unknown");
  assert.equal(result.nextAction.kind, "start_closing");
});

test("moveToNextMainQuestion follows what the learner heard when the plan wanted a follow-up", () => {
  const afterPartial = answer(compileSessionPlan(resumeAgent()), "partial").state;
  assert.equal(summarizeSessionPlan(afterPartial).nextAction.kind, "ask_follow_up");

  const corrected = moveToNextMainQuestion(afterPartial);
  assert.equal(corrected.moved, true);
  assert.equal(summarizeSessionPlan(corrected.state).activeQuestion?.id, "deep-dive:resume:2");
  assert.equal(summarizeSessionPlan(afterPartial).activeQuestion?.id, "deep-dive:resume:1"); // input untouched

  const lastQuestion = answer(answer(compileSessionPlan(resumeAgent()), "strong").state, "partial").state;
  assert.equal(moveToNextMainQuestion(lastQuestion).moved, false);
});

test("start_closing can be applied right after recording the last answer (one-call closing)", () => {
  let state = compileSessionPlan(resumeAgent());
  state = answer(state, "strong").state;
  state = answer(state, "strong").state; // both main questions done
  assert.equal(summarizeSessionPlan(state).nextAction.kind, "start_closing");
  const closing = advanceSessionPlan(structuredClone(state), { type: "start_closing" });
  assert.equal(closing.state.closingState, "awaiting_confirmation");
  assert.equal(closing.nextAction.kind, "await_confirmation");
});

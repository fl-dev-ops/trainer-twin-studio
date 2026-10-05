import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCodeAssessment,
  advanceSessionPlan,
  assertActivePlanQuestion,
  canFinishSession,
  classifyAnswerAssessment,
  compileSessionPlan,
  summarizeSessionPlan,
} from "./session-plan";

test("derives strict answer statuses from observable qualities", () => {
  const strong = {
    substantive: true,
    direct: true,
    specific: true,
    mechanismOrEvidence: true,
    complete: true,
    contradiction: false,
  };
  assert.equal(classifyAnswerAssessment(strong), "strong");
  assert.equal(classifyAnswerAssessment({ ...strong, complete: false }), "partial");
  assert.equal(classifyAnswerAssessment({ ...strong, mechanismOrEvidence: false }), "partial");
  assert.equal(classifyAnswerAssessment({ ...strong, specific: false }), "vague");
  assert.equal(classifyAnswerAssessment({ ...strong, direct: false }), "vague");
  assert.equal(classifyAnswerAssessment({ ...strong, substantive: false }), "unknown");
  assert.equal(classifyAnswerAssessment({ ...strong, contradiction: true }), "contradictory");
});

test("incomplete code cannot become strong without a new submission", () => {
  const incomplete = applyCodeAssessment("strong", "incomplete", 1);
  assert.deepEqual(incomplete, { answerStatus: "partial", incompleteRevision: 1 });
  assert.deepEqual(
    applyCodeAssessment("strong", "complete", 1, incomplete.incompleteRevision ?? undefined),
    { answerStatus: "partial", incompleteRevision: 1 },
  );
  assert.deepEqual(
    applyCodeAssessment("strong", "complete", 2, incomplete.incompleteRevision ?? undefined),
    { answerStatus: "strong", incompleteRevision: null },
  );
});

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
  assert.equal(plan.rounds[0].maximumTurns, 15);
  assert.equal(plan.sessionMaximumTurns, 15);
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

test("records at most one learner answer per runtime turn", () => {
  const plan = compileSessionPlan(technicalAgent());

  advanceSessionPlan(plan, { type: "record_answer", answerStatus: "strong", turnId: "turn-1" });
  assert.throws(
    () => advanceSessionPlan(plan, { type: "record_answer", answerStatus: "strong", turnId: "turn-1" }),
    /already recorded/,
  );
  assert.equal(summarizeSessionPlan(plan).activeQuestion?.id, "fundamental-knowledge:verbal:2");
});

test("planned surfaces must match the active question", () => {
  const plan = compileSessionPlan(technicalAgent());

  assert.doesNotThrow(() => assertActivePlanQuestion(plan, "fundamental-knowledge:verbal:1", ["verbal"]));
  assert.throws(() => assertActivePlanQuestion(null, "question-1", ["mcq"]), /not initialized/);
  assert.throws(
    () => assertActivePlanQuestion(plan, "fundamental-knowledge:mcq:1", ["mcq"]),
    /does not match the active session plan item/,
  );
});

test("preserves every configured main question and follow-up allowance", () => {
  const agent: any = technicalAgent();
  agent.config.turns.maximum = 5;
  agent.stages[0].config.turns.maximum = 5;
  agent.stages[0].config.evidence.completion_keys = [];
  const plan = compileSessionPlan(agent);

  for (let index = 0; index < 15; index += 1) {
    advanceSessionPlan(plan, { type: "record_answer", answerStatus: "partial" });
  }

  assert.equal(plan.sessionMaximumTurns, 15);
  assert.equal(plan.rounds[0].questions.filter(({ status }) => status === "done").length, 5);
  assert.equal(plan.rounds[0].questions.every(({ followUpsUsed }) => followUpsUsed === 2), true);
  assert.equal(summarizeSessionPlan(plan).nextAction.kind, "start_closing");
});

test("expands a turn ceiling that is smaller than the configured question count", () => {
  const agent: any = technicalAgent();
  agent.config.turns.maximum = 2;
  agent.stages[0].config.turns.maximum = 2;
  const plan = compileSessionPlan(agent);

  assert.equal(plan.sessionMaximumTurns, 15);
  assert.equal(plan.rounds[0].maximumTurns, 15);
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
  assert.equal(canFinishSession(plan), false);
  advanceSessionPlan(plan, { type: "start_closing" });
  assert.equal(summarizeSessionPlan(plan).nextAction.kind, "await_confirmation");
  assert.equal(canFinishSession(plan), false);

  advanceSessionPlan(plan, { type: "learner_question_during_closing" });
  assert.equal(summarizeSessionPlan(plan).nextAction.kind, "await_confirmation");
  advanceSessionPlan(plan, { type: "confirm_end" });
  assert.equal(summarizeSessionPlan(plan).nextAction.kind, "finish_session");
  assert.equal(canFinishSession(plan), true);
});

import assert from "node:assert/strict";
import test from "node:test";
import { bridgeableQuestion, bridgeableReply, createQuestionBridge, highlightStatus } from "../../../agent/lib/question-bridge";

const call = (input: unknown, toolName = "start_resume_question", callId = "call-1") => ({ kind: "tool-call", callId, toolName, input });
const result = (output: unknown, extra: Record<string, unknown> = {}) => ({
  kind: "tool-result",
  callId: "call-1",
  toolName: "start_resume_question",
  output,
  ...extra,
});
const planResult = (kind: string) => ({ kind: "tool-result", callId: "plan-1", toolName: "session_plan", output: { nextAction: { kind } } });
const question = (text = "What did you build?") => call({ claimId: "c1", question: text });
const planReply = (reply: unknown) => call({ action: "record_answer", answerStatus: "partial", reply }, "session_plan", "plan-1");

test("bridges only valid resume main questions and plan replies", () => {
  assert.equal(bridgeableQuestion(question(" What did you own in the payments rewrite? ")), "What did you own in the payments rewrite?");
  assert.equal(bridgeableQuestion(question("Why? And how?")), null);
  assert.equal(bridgeableQuestion(question(`${"x".repeat(500)}?`)), null);
  assert.equal(bridgeableQuestion(call({ question: "What did you build?" })), null);
  assert.equal(bridgeableQuestion(call({ claimId: "c1", question: "What did you build?" }, "surface")), null);
  assert.equal(bridgeableReply(planReply(" How did you measure that? ")), "How did you measure that?");
  assert.equal(bridgeableReply(planReply("")), null);
  assert.equal(bridgeableReply(planReply("x".repeat(601))), null);
  assert.equal(bridgeableReply(call({ action: "record_answer" }, "session_plan")), null);
});

test("speaks the question at the tool call and drops the model's repeat once highlighted", () => {
  const bridge = createQuestionBridge("voice");
  assert.equal(bridge.onToolCalls([question()]), "What did you build?\n");
  bridge.onToolResult(result({ status: "highlighted" }));
  assert.equal(bridge.onModelText("What did you build?"), null);
  assert.equal(bridge.trace(0).bridged_result, "highlighted");
  assert.equal(bridge.trace(0).suppressed_text_chars, 19);
});

test("forwards the model's recovery text when the highlight is not confirmed", () => {
  for (const outcome of [result({ status: "not_found" }), result({ value: { status: "viewer_unavailable" } }), result(null, { isError: true })]) {
    const bridge = createQuestionBridge("voice");
    bridge.onToolCalls([question()]);
    bridge.onToolResult(outcome);
    assert.equal(bridge.onModelText("Could you point me to it?"), "Could you point me to it?");
  }
});

test("one-call follow-up: speaks session_plan.reply and drops all later model text", () => {
  const bridge = createQuestionBridge("voice");
  assert.equal(bridge.onToolCalls([planReply("How did you measure the drop in failures?")]), "How did you measure the drop in failures?\n");
  bridge.onToolResult(planResult("ask_follow_up"));
  assert.equal(bridge.onModelText("How did you measure"), null);
  const trace = bridge.trace(0);
  assert.equal(trace.bridged_reply, true);
  assert.equal(trace.plan_next_action, "ask_follow_up");
  assert.equal(trace.plan_mismatch, false);
});

test("a failed bridged plan call forwards recovery, but unrelated failures do not", () => {
  const bridge = createQuestionBridge("voice");
  assert.equal(bridge.onToolCalls([planReply("How did you measure that?")]), "How did you measure that?\n");
  bridge.onToolResult({ kind: "tool-result", callId: "other-call", toolName: "search_style", isError: true });
  assert.equal(bridge.onModelText("How did you measure that?"), null);
  bridge.onToolResult({ kind: "tool-result", callId: "plan-1", toolName: "session_plan", isError: true });
  assert.equal(bridge.onModelText("Sorry, let me record that answer again."), "Sorry, let me record that answer again.");
  assert.equal(bridge.trace(0).bridged_result, "error");
});

test("a tool-error event for the bridged plan call also forwards recovery", () => {
  const bridge = createQuestionBridge("voice");
  bridge.onToolCalls([planReply("How did you measure that?")]);
  bridge.onToolResult({ kind: "tool-error", callId: "plan-1", toolName: "session_plan" });
  assert.equal(bridge.onModelText("Please give me a moment."), "Please give me a moment.");
});

test("one-call new question: the resume question wins over a reply in the same response", () => {
  const bridge = createQuestionBridge("voice");
  assert.equal(bridge.onToolCalls([planReply("Great, thanks."), question()]), "What did you build?\n");
  bridge.onToolResult(planResult("pose_main_question"));
  assert.equal(bridge.trace(0).bridged_question, true);
  assert.equal(bridge.trace(0).plan_mismatch, false);
});

test("flags a mismatch between what was spoken and the plan's next action", () => {
  const spokeFollowUp = createQuestionBridge("voice");
  spokeFollowUp.onToolCalls([planReply("Tell me more about the rollout?")]);
  spokeFollowUp.onToolResult(planResult("pose_main_question"));
  assert.equal(spokeFollowUp.trace(0).plan_mismatch, true);

  const spokeNewQuestion = createQuestionBridge("voice");
  spokeNewQuestion.onToolCalls([question()]);
  spokeNewQuestion.onToolResult(planResult("ask_follow_up"));
  assert.equal(spokeNewQuestion.trace(0).plan_mismatch, true);
});

test("never bridges in chat mode", () => {
  const bridge = createQuestionBridge("chat");
  assert.equal(bridge.onToolCalls([question(), planReply("Hi?")]), null);
  assert.equal(bridge.onModelText("What did you build?"), "What did you build?");
  assert.equal(bridge.trace(0).bridged_question, false);
});

test("reads the status from plain and wrapped tool outputs", () => {
  assert.equal(highlightStatus(result({ status: "highlighted" })), "highlighted");
  assert.equal(highlightStatus(result({ value: { status: "not_found" } })), "not_found");
  assert.equal(highlightStatus({ kind: "tool-error", callId: "call-1" }), null);
});

test("one-call new question: plan outcome comes from start_resume_question itself", () => {
  const matched = createQuestionBridge("voice");
  matched.onToolCalls([call({ claimId: "c1", question: "What did you build?", answerStatus: "strong" })]);
  matched.onToolResult(result({ status: "highlighted", nextAction: { kind: "pose_main_question" } }));
  assert.equal(matched.trace(0).plan_next_action, "pose_main_question");
  assert.equal(matched.trace(0).plan_mismatch, false);

  const mismatched = createQuestionBridge("voice");
  mismatched.onToolCalls([call({ claimId: "c1", question: "What did you build?", answerStatus: "partial" })]);
  mismatched.onToolResult(result({ status: "highlighted", nextAction: { kind: "ask_follow_up" }, planMismatch: true }));
  assert.equal(mismatched.trace(0).plan_mismatch, true);
});

test("never re-speaks a spent claim and speaks at most one question per turn (12:45 am replay)", () => {
  const used = new Set<string>();
  const ask = (claimId: string, callId: string) => call({ claimId, question: `About ${claimId}, what did you own?` }, "start_resume_question", callId);

  // Turn 1: claim 000d is highlighted -> spent for the session.
  const turn1 = createQuestionBridge("voice", used);
  assert.equal(turn1.onToolCalls([ask("000d", "a")]), "About 000d, what did you own?\n");
  turn1.onToolResult({ kind: "tool-result", callId: "a", toolName: "start_resume_question", output: { status: "highlighted" } });
  assert.ok(used.has("000d"));

  // Turn 2: the model retries 000d (web app rejects it), then picks 0009.
  const turn2 = createQuestionBridge("voice", used);
  assert.equal(turn2.onToolCalls([ask("000d", "b")]), null);
  turn2.onToolResult({ kind: "tool-error", callId: "b", toolName: "start_resume_question", isError: true });
  assert.equal(turn2.onToolCalls([ask("0009", "c")]), "About 0009, what did you own?\n");
  assert.equal(turn2.onToolCalls([ask("0010", "d")]), null);
});

test("holds a follow-up reply whose grade leads to a new question (9:25 am replay)", () => {
  const strongReply = call({ action: "record_answer", answerStatus: "strong", reply: "How did the retry keep state?" }, "session_plan", "plan-1");
  const partialReply = call({ action: "record_answer", answerStatus: "partial", reply: "How did the retry keep state?" }, "session_plan", "plan-2");
  const followUpGrades = () => ["partial", "vague", "contradictory", "unknown"];

  const bridge = createQuestionBridge("voice", new Set(), followUpGrades);
  assert.equal(bridge.onToolCalls([strongReply]), null);
  // the model's next step poses the new question; only that is spoken
  assert.equal(bridge.onToolCalls([question("Looking at the dual-mode platform, what did you build?")]), "Looking at the dual-mode platform, what did you build?\n");
  assert.equal(bridge.trace(0).held_replies, 1);

  assert.equal(createQuestionBridge("voice", new Set(), followUpGrades).onToolCalls([partialReply]), "How did the retry keep state?\n");
  // grades unknown (e.g. separate processes): keep today's behaviour
  assert.equal(createQuestionBridge("voice", new Set(), () => null).onToolCalls([strongReply]), "How did the retry keep state?\n");
});

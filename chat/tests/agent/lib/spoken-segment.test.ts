import assert from "node:assert/strict";
import test from "node:test";
import {
  appendSpokenText,
  CLOSING_CONFIRMATION_PROMPT,
  enforceClosingSpeech,
  enforcePlanSpeech,
  enforceSingleFocalQuestion,
  enforceWordLimit,
  isClosingConfirmation,
  KNOWLEDGE_GROUNDING_PROMPT,
  resetSpokenTextForTool,
} from "../../../agent/lib/spoken-segment";

test("keeps only speech generated after the last tool call", () => {
  let text = appendSpokenText("", "Why did you choose feature flags?");
  text = resetSpokenTextForTool(text, true);
  text = appendSpokenText(text, "What did you build in the Sentry project?");

  assert.equal(text, "What did you build in the Sentry project?");
});

test("keeps only the first question", () => {
  assert.equal(
    enforceSingleFocalQuestion("Good points. What happens when microtasks accumulate? How does that affect rendering?"),
    "Good points. What happens when microtasks accumulate?",
  );
});

test("removes a repeated directive before a focal question", () => {
  assert.equal(
    enforceSingleFocalQuestion("Please share the exact line inside the callback.Could you specify the exact line inside the callback?"),
    "Please share the exact line inside the callback.",
  );
});

test("suppresses speech without an advancing session plan call", () => {
  assert.equal(enforcePlanSpeech("What happens next?", {
    planRequired: true,
    planResult: null,
    planAdvanced: false,
    completedSurfaces: [],
  }), "");
  assert.equal(enforcePlanSpeech("What happens next?", {
    planRequired: true,
    planResult: { nextAction: { kind: "ask_follow_up", questionId: "q1", questionType: "verbal" } },
    planAdvanced: false,
    completedSurfaces: [],
  }), "");
});

test("uses deterministic prompts when a submission gate blocks progression", () => {
  const options = { planRequired: true, planAdvanced: true, completedSurfaces: [] };
  assert.equal(enforcePlanSpeech("I cannot see it.", {
    ...options,
    planResult: { blockedReason: "code_submission_required" },
  }), "Please submit your current code in the editor so I can review it.");
  assert.equal(enforcePlanSpeech("What is your answer?", {
    ...options,
    planResult: { blockedReason: "mcq_selection_required" },
  }), "Please select and submit an option before we continue.");
});

test("replaces ungrounded technical judgment with a neutral probe", () => {
  const options = {
    planRequired: true,
    planAdvanced: true,
    completedSurfaces: [],
    knowledgeRequired: true,
    knowledgeGrounded: false,
  };
  assert.equal(enforcePlanSpeech("That answer is correct.", {
    ...options,
    planResult: { nextAction: { kind: "ask_follow_up", questionId: "q1", questionType: "verbal" } },
  }), KNOWLEDGE_GROUNDING_PROMPT);
  assert.equal(enforcePlanSpeech("That answer is correct.", {
    ...options,
    knowledgeGrounded: true,
    planResult: { nextAction: { kind: "ask_follow_up", questionId: "q1", questionType: "verbal" } },
  }), "That answer is correct.");
  assert.equal(enforcePlanSpeech("Technical judgment.", {
    ...options,
    knowledgeRequired: false,
    planResult: { blockedReason: "knowledge_grounding_required" },
  }), KNOWLEDGE_GROUNDING_PROMPT);
});

test("requires the planned surface before posing a visual question", () => {
  const planResult = { nextAction: { kind: "pose_main_question", questionId: "q1", questionType: "coding" } };
  const options = { planRequired: true, planResult, planAdvanced: true };
  assert.equal(enforcePlanSpeech("Implement debounce.", { ...options, completedSurfaces: [] }), "");
  assert.equal(enforcePlanSpeech("Implement debounce.", {
    ...options,
    completedSurfaces: [{ action: "open_code_editor", questionId: "q1" }],
  }), "Implement debounce.");
});

test("does not allow a new main-question surface for a follow-up", () => {
  assert.equal(enforcePlanSpeech("What is missing?", {
    planRequired: true,
    planResult: { nextAction: { kind: "ask_follow_up", questionId: "q1", questionType: "coding" } },
    planAdvanced: true,
    completedSurfaces: [{ action: "open_code_editor", questionId: "q1" }],
  }), "");
});

test("removes a compound focal clause", () => {
  assert.equal(
    enforceSingleFocalQuestion("How does the queue drain, and why does that affect responsiveness?"),
    "How does the queue drain?",
  );
});

test("separates implementation from a second explanation request", () => {
  assert.equal(
    enforceSingleFocalQuestion("Write a debounce function. Then explain its event-loop behavior."),
    "Write a debounce function.",
  );
});

test("keeps the focal question when enforcing the word limit", () => {
  const text = "Your answer established the event loop, call stack, microtask queue, macrotask queue, promise scheduling, rendering behavior, starvation risk, browser APIs, and asynchronous callbacks with a clear overall model. The remaining gap is connecting those pieces to concrete execution order under pressure. What runs immediately after the current call stack becomes empty?";
  const result = enforceWordLimit(text, 45);

  assert.equal(result.split(/\s+/).length <= 45, true);
  assert.equal(result.endsWith("What runs immediately after the current call stack becomes empty?"), true);
});

test("returns complete sentences when shortening feedback", () => {
  const result = enforceWordLimit(
    "This first sentence contains several useful words about the candidate response. This second sentence adds detail that cannot fit inside the configured limit. Final fragment should not appear.",
    12,
  );

  assert.equal(result, "This first sentence contains several useful words about the candidate response.");
});

test("uses a deterministic closing confirmation prompt", () => {
  assert.equal(enforceClosingSpeech("Model-generated closing.", "started"), CLOSING_CONFIRMATION_PROMPT);
  assert.equal(enforceClosingSpeech("I am finishing now.", "ended"), "");
});

test("answers a learner question and asks to close again", () => {
  assert.equal(
    enforceClosingSpeech("A microtask checkpoint drains the queue before rendering. Anything else?", "question-answered"),
    `A microtask checkpoint drains the queue before rendering. ${CLOSING_CONFIRMATION_PROMPT}`,
  );
});

test("recognizes only clear closing confirmations", () => {
  assert.equal(isClosingConfirmation("Yes."), true);
  assert.equal(isClosingConfirmation("No, I'm good."), true);
  assert.equal(isClosingConfirmation("We can wrap up"), true);
  assert.equal(isClosingConfirmation("Can you explain promises?"), false);
  assert.equal(isClosingConfirmation("Not yet"), false);
});

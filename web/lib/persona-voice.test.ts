import assert from "node:assert/strict";
import test from "node:test";
import { extractPersonaVoiceChunks, extractPersonaVoiceMoments, personaCollectionName, personaCoverageLevel, shouldRebuildPersona } from "./persona-voice";

test("storage identity uses immutable persona IDs", () => {
  assert.equal(personaCollectionName("persona-id-a"), "persona_persona-id-a");
  assert.notEqual(personaCollectionName("persona-id-a"), personaCollectionName("persona-id-b"));
});

test("paired persona moments take precedence over duplicate fallback phrases", () => {
  assert.deepEqual(extractPersonaVoiceChunks({
    conversation_moments: [{
      candidate_context: "We improved conversion by ten percent.",
      action: "request_justification",
      interviewer_response: "How did you measure that?",
    }],
    behavioral_patterns: {
      on_unsupported_claim: {
        action: "request_justification",
        examples: ["How did you measure that?"],
      },
    },
    verbatim_phrases: {
      ask_exact_example: ["Walk me through one specific case."],
    },
  }), [
    "Action: request_justification\nInterviewer: How did you measure that?",
    "Action: ask_exact_example\nInterviewer: Walk me through one specific case.",
  ]);
});

test("extracted moments carry action and learner state", () => {
  const moments = extractPersonaVoiceMoments({
    conversation_moments: [{
      candidate_context: "We improved conversion by ten percent.",
      action: "request_justification",
      interviewer_response: "How did you measure that?",
    }],
  });
  assert.equal(moments[0]?.action, "request_justification");
  assert.equal(moments[0]?.learnerState, "vague");
  assert.equal(moments[0]?.move, "probe");
  assert.equal(moments[0]?.candidateContext, "We improved conversion by ten percent.");
  assert.equal(moments[0]?.text.includes("Candidate:"), false);
  assert.match(moments[0]?.text ?? "", /^Action: request_justification\nInterviewer: /);
});

test("interviewer embed text is capped and omits candidate speech", () => {
  const spoken = `${"word ".repeat(200)}end`;
  const moments = extractPersonaVoiceMoments({
    conversation_moments: [{
      candidate_context: "I built a billing pipeline at Stripe.",
      action: "ask_exact_example",
      interviewer_response: spoken,
    }],
  });
  assert.ok((moments[0]?.text.length ?? 0) <= 450);
  assert.ok((moments[0]?.text.split("Interviewer: ")[1]?.length ?? 0) <= 401);
  assert.equal(moments[0]?.text.includes("Stripe"), false);
  assert.equal(moments[0]?.candidateContext?.includes("Stripe"), true);
});

test("persona coverage uses moment and action counts", () => {
  assert.equal(personaCoverageLevel([]), "low");
  assert.equal(personaCoverageLevel([
    { metadata: { voiceMoments: 25, voiceActions: ["a", "b", "c"] } },
  ]), "medium");
});

test("persona compiles only after the final source settles", () => {
  assert.equal(shouldRebuildPersona([
    { id: "latest", status: "analyzed" },
    { id: "older", status: "analyzing" },
  ], "latest"), false);
  assert.equal(shouldRebuildPersona([
    { id: "latest", status: "analyzed" },
    { id: "older", status: "analyzed" },
  ], "older"), false);
  assert.equal(shouldRebuildPersona([
    { id: "latest", status: "analyzed" },
    { id: "older", status: "analyzed" },
  ], "latest"), true);
});

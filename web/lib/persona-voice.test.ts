import assert from "node:assert/strict";
import test from "node:test";
import { extractPersonaVoiceChunks, personaCollectionName, shouldRebuildPersona } from "./persona-voice";

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
    "Candidate: We improved conversion by ten percent.\nAction: request_justification\nInterviewer: How did you measure that?",
    "Action: ask_exact_example\nInterviewer: Walk me through one specific case.",
  ]);
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

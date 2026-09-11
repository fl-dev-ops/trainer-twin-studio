import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PERSONA_ANALYSIS_ATTEMPTS,
  PERSONA_ANALYSIS_TOPIC,
  PersonaAnalysisBusyError,
  personaAnalysisAttempts,
  personaAnalysisMessageSchema,
  personaSourceIsComplete,
} from "./persona-analysis-queue";

test("persona analysis topic and schema", () => {
  assert.equal(PERSONA_ANALYSIS_TOPIC, "persona-analysis");
  assert.equal(MAX_PERSONA_ANALYSIS_ATTEMPTS, 3);
  assert.deepEqual(personaAnalysisMessageSchema.parse({ sourceId: "src_123" }), { sourceId: "src_123" });
  assert.throws(() => personaAnalysisMessageSchema.parse({}));
  assert.throws(() => personaAnalysisMessageSchema.parse({ sourceId: "" }));
  assert.throws(() => personaAnalysisMessageSchema.parse({ sourceId: "src_123", extra: true }));
});

test("persona analysis attempts extraction", () => {
  assert.equal(personaAnalysisAttempts(null), 0);
  assert.equal(personaAnalysisAttempts({}), 0);
  assert.equal(personaAnalysisAttempts({ analysisAttempts: 2 }), 2);
  assert.equal(personaAnalysisAttempts({ analysisAttempts: "invalid" }), 0);
  assert.equal(personaAnalysisAttempts({ analysisAttempts: -1 }), 0);
});

test("personaSourceIsComplete checks analyzed status and voice moments", () => {
  assert.equal(personaSourceIsComplete("uploaded", { voiceMoments: 5 }), false);
  assert.equal(personaSourceIsComplete("analyzed", {}), false);
  assert.equal(personaSourceIsComplete("analyzed", { voiceMoments: 0 }), false);
  assert.equal(personaSourceIsComplete("analyzed", { voiceMoments: 10 }), true);
});

test("PersonaAnalysisBusyError maintains error contract", () => {
  const err = new PersonaAnalysisBusyError();
  assert.equal(err.name, "PersonaAnalysisBusyError");
  assert.match(err.message, /being analyzed/);
});

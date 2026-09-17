import assert from "node:assert/strict";
import test from "node:test";
import {
  applyLearnerUpload,
  contextUploadFromAgentData,
  resolveContextUpload,
} from "./context-upload";

test("resume mode required uses résumé copy", () => {
  const upload = resolveContextUpload({ mode: "resume_grounding", required: true });
  assert.equal(upload.required, true);
  assert.equal(upload.label, "Résumé");
  assert.match(upload.prompt, /résumé/i);
  assert.match(upload.accept, /\.pdf/);
});

test("custom prompt wins", () => {
  const upload = resolveContextUpload({
    mode: "session_evidence",
    required: true,
    prompt: "Upload the take-home PDF.",
    label: "Take-home",
  });
  assert.equal(upload.prompt, "Upload the take-home PDF.");
  assert.equal(upload.label, "Take-home");
});

test("not required hides the dropzone", () => {
  assert.equal(resolveContextUpload({ mode: "none", required: false }).required, false);
});

test("stage-level required is enough for full-mock style specs", () => {
  const upload = contextUploadFromAgentData({
    config: { context: { mode: "none", required: false, prompt: "Upload your current résumé as a PDF." } },
    stages: [{ config: { context: { mode: "resume_grounding", required: true } } }],
  });
  assert.equal(upload.required, true);
  assert.equal(upload.label, "Résumé");
  assert.match(upload.prompt, /résumé/i);
});

test("generate overlay stamps résumé upload on resume interviews", () => {
  const context = applyLearnerUpload({ mode: "none", required: false }, { interviewType: "resume" });
  assert.equal(context.required, true);
  assert.equal(context.mode, "resume_grounding");
  assert.equal(context.prompt, "Upload your current résumé as a PDF.");
});

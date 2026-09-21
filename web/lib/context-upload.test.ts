import assert from "node:assert/strict";
import test from "node:test";
import {
  applyLearnerUpload,
  contextUploadFromAgentData,
  resolveContextUpload,
} from "./context-upload";

test("resume mode uses the default documents label", () => {
  const upload = resolveContextUpload({ mode: "resume_grounding", required: true });
  assert.equal(upload.required, true);
  assert.equal(upload.label, "Documents");
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

test("labels pass through, empty falls back to documents", () => {
  assert.equal(resolveContextUpload({ label: "Résumé" }).label, "Résumé");
  assert.equal(resolveContextUpload({ label: "Context document" }).label, "Context document");
  assert.equal(resolveContextUpload({}).label, "Documents");
});

test("max_files clamps to 1-5, defaults to 1", () => {
  assert.equal(resolveContextUpload({ max_files: 3 }).maxFiles, 3);
  assert.equal(resolveContextUpload({ max_files: 99 }).maxFiles, 5);
  assert.equal(resolveContextUpload({ max_files: 0 }).maxFiles, 1);
  assert.equal(resolveContextUpload({}).maxFiles, 1);
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
  assert.equal(upload.label, "Documents");
  assert.match(upload.prompt, /résumé/i);
});

test("generate overlay stamps résumé upload on resume interviews", () => {
  const context = applyLearnerUpload({ mode: "none", required: false }, { interviewType: "resume" });
  assert.equal(context.required, true);
  assert.equal(context.mode, "resume_grounding");
  assert.equal(context.prompt, "Upload your current résumé as a PDF.");
});

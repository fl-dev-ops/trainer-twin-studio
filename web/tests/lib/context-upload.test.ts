import assert from "node:assert/strict";
import test from "node:test";
import {
  applyLearnerUpload,
  beforeSettings,
  contextUploadFromAgentData,
  resolveContextUpload,
  usesBeforeSettings,
} from "@/lib/context-upload";

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

test("role plays keep their rules: card only when required, whole screen, no mid-call attach", () => {
  const upload = contextUploadFromAgentData({ config: { context: { mode: "session_evidence", required: false } } }, "ROLEPLAY");
  assert.equal(upload.offered, false);
  assert.equal(upload.allowed, true);
  assert.equal(upload.screenShare, true);
  assert.equal(upload.duringSession, false);
  assert.equal(contextUploadFromAgentData({}).screenShare, true);
});

test("twins follow their configure page; an unconfigured twin asks for nothing", () => {
  const off = contextUploadFromAgentData({}, "TWIN");
  assert.deepEqual(
    { offered: off.offered, allowed: off.allowed, screenShare: off.screenShare, duringSession: off.duringSession, required: off.required },
    { offered: false, allowed: false, screenShare: false, duringSession: false, required: false },
  );
  const on = contextUploadFromAgentData({
    twinSettings: { preScreenshare: true, preUpload: true, duringUpload: true, uploadTitle: " Brochure ", uploadInstruction: "Add the listing brochure." },
  }, "TWIN");
  assert.equal(on.offered, true);
  assert.equal(on.allowed, true);
  assert.equal(on.required, false);
  assert.equal(on.screenShare, true);
  assert.equal(on.duringSession, true);
  assert.equal(on.label, "Brochure");
  assert.equal(on.prompt, "Add the listing brochure.");
  assert.equal(contextUploadFromAgentData({ twinSettings: { preUpload: true } }, "TWIN").label, "Documents");
});

test("before settings: `before` wins over an older twinSettings; a role play follows them once it has a before block", () => {
  const twin = contextUploadFromAgentData({ twinSettings: { preUpload: true }, before: { preUpload: false, duringUpload: true } }, "TWIN");
  assert.equal(twin.allowed, false);
  assert.equal(twin.duringSession, true);
  assert.equal(usesBeforeSettings({}, "TWIN"), true);
  assert.equal(usesBeforeSettings({}, "ROLEPLAY"), false);
  assert.equal(usesBeforeSettings({ twinSettings: { preUpload: true } }, "ROLEPLAY"), false);
  const roleplay = contextUploadFromAgentData({ before: { preScreenshare: false, preUpload: true, uploadTitle: "Listing" } }, "ROLEPLAY");
  assert.deepEqual(
    { offered: roleplay.offered, screenShare: roleplay.screenShare, label: roleplay.label, duringSession: roleplay.duringSession },
    { offered: true, screenShare: false, label: "Listing", duringSession: false },
  );
  assert.deepEqual(beforeSettings({}), { preScreenshare: false, preUpload: false, duringUpload: false, uploadTitle: "", uploadInstruction: "" });
});

test("generate overlay stamps résumé upload on resume interviews", () => {
  const context = applyLearnerUpload({ mode: "none", required: false }, { interviewType: "resume" });
  assert.equal(context.required, true);
  assert.equal(context.mode, "resume_grounding");
  assert.equal(context.prompt, "Upload your current résumé as a PDF.");
});

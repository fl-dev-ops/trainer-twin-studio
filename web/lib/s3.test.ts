import assert from "node:assert/strict";
import test from "node:test";

test("S3 keys are rooted by immutable organization ID", async () => {
  // Note: lib/s3 reads S3_BASE_PREFIX at module-evaluation time, which may
  // already have happened via another test's import (bun caches modules per
  // process). So assert the org-rooting contract relative to the base prefix
  // instead of a hard-coded prefix value.
  const { kbPrefix, personaSourcePrefix, recordingKey, voicePrefix } = await import("./s3");
  const base = kbPrefix("org-id", "kb-id", "doc-id").split("/org-id/")[0];

  assert.equal(kbPrefix("org-id", "kb-id", "doc-id"), `${base}/org-id/knowledge/kb-id/doc-id`);
  assert.equal(voicePrefix("org-id", "voice-id"), `${base}/org-id/tts-voices/voice-id`);
  assert.equal(recordingKey("org-id", "session-id"), `${base}/org-id/recordings/session-id.wav`);
  assert.equal(personaSourcePrefix("org-id", "persona-id"), `${base}/org-id/personas/persona-id/sources`);
});

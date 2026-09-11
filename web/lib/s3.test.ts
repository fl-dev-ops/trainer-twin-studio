import assert from "node:assert/strict";
import test from "node:test";

test("S3 keys are rooted by immutable organization ID", async () => {
  process.env.S3_BASE_PREFIX = "trainertwin-dev";
  const { kbPrefix, personaSourcePrefix, recordingKey, voicePrefix } = await import("./s3");

  assert.equal(kbPrefix("org-id", "kb-id", "doc-id"), "trainertwin-dev/org-id/knowledge/kb-id/doc-id");
  assert.equal(voicePrefix("org-id", "voice-id"), "trainertwin-dev/org-id/tts-voices/voice-id");
  assert.equal(recordingKey("org-id", "session-id"), "trainertwin-dev/org-id/recordings/session-id.wav");
  assert.equal(personaSourcePrefix("org-id", "persona-id"), "trainertwin-dev/org-id/personas/persona-id/sources");
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeSessionEvidence,
  resolveSessionEndStatus,
  shouldStoreSessionTranscript,
} from "../../../lib/interview-sessions";

test("browser finalization closes active sessions without downgrading completed ones", () => {
  assert.equal(resolveSessionEndStatus("active", "abandoned"), "abandoned");
  assert.equal(resolveSessionEndStatus("active", "completed"), "completed");
  assert.equal(resolveSessionEndStatus("completed", "abandoned"), "completed");
  assert.equal(resolveSessionEndStatus("completed", "completed"), "completed");
});

test("session finalization preserves canonical transcript and merges late evidence", () => {
  assert.equal(shouldStoreSessionTranscript([], [{ role: "user", text: "answer" }]), true);
  assert.equal(
    shouldStoreSessionTranscript([{ role: "user", text: "canonical" }], [{ role: "user", text: "late" }]),
    false,
  );
  assert.deepEqual(
    mergeSessionEvidence({ coverage: "complete", score: 1 }, { score: 2, audioKey: "recording.wav" }),
    { coverage: "complete", score: 2, audioKey: "recording.wav" },
  );
});

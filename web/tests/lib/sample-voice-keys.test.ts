import { expect, test } from "bun:test";
import { hasValidVoiceObjectKeys } from "@/lib/voices";
import { sampleVoicePrefix, voicePrefix } from "@/lib/s3";

const sample = (key: string) => ({ id: "ethan-sample", orgId: null, kind: "sample" as const, s3AudioKey: key, s3TranscriptKey: null });

test("built-in sample voices are valid in the bucket's shared folder, whatever the base prefix", () => {
  expect(sampleVoicePrefix("ethan-sample")).toMatch(/^[^/]+\/shared\/tts-voices\/ethan-sample$/);
  expect(hasValidVoiceObjectKeys(sample(`${sampleVoicePrefix("ethan-sample")}/reference.wav`))).toBe(true);
  expect(hasValidVoiceObjectKeys(sample(`${voicePrefix("shared", "ethan-sample")}/reference.wav`))).toBe(true);
  // Another voice's folder, traversal and a bare folder stay refused.
  expect(hasValidVoiceObjectKeys(sample(`${sampleVoicePrefix("other-sample")}/reference.wav`))).toBe(false);
  expect(hasValidVoiceObjectKeys(sample(`${sampleVoicePrefix("ethan-sample")}/../x.wav`))).toBe(false);
  expect(hasValidVoiceObjectKeys(sample(`${sampleVoicePrefix("ethan-sample")}/`))).toBe(false);
  // Org voices never use the shared folder.
  expect(hasValidVoiceObjectKeys({ ...sample(`${sampleVoicePrefix("ethan-sample")}/reference.wav`), orgId: "org1", kind: "cloned" as never })).toBe(false);
});

import { expect, test } from "bun:test";
import { hasValidVoiceObjectKeys } from "@/lib/voices";
import { sampleVoicePrefix, voicePrefix } from "@/lib/s3";

const voice = (key: string, over: Partial<{ id: string; orgId: string | null; kind: string }> = {}) =>
  ({ id: "v1", orgId: "org1", kind: "cloned", s3AudioKey: key, s3TranscriptKey: null, ...over }) as Parameters<typeof hasValidVoiceObjectKeys>[0];

test("an org voice is valid in its own folder under any environment's base prefix (keys keep the prefix they were written with)", () => {
  for (const base of ["trainertwin-dev/kb", "trainertwin/kb", "prod/trainertwin/kb"]) {
    expect(hasValidVoiceObjectKeys(voice(`${base}/org1/tts-voices/v1/reference-abc.wav`))).toBe(true);
  }
  expect(hasValidVoiceObjectKeys(voice(`${voicePrefix("org1", "v1")}/reference.wav`))).toBe(true);
});

test("a voice never points at another org's or another voice's files, and no key escapes its folder", () => {
  expect(hasValidVoiceObjectKeys(voice("trainertwin/kb/org2/tts-voices/v1/reference.wav"))).toBe(false);
  expect(hasValidVoiceObjectKeys(voice("trainertwin/kb/org1/tts-voices/v2/reference.wav"))).toBe(false);
  expect(hasValidVoiceObjectKeys(voice("trainertwin/kb/org1/tts-voices/v1/"))).toBe(false);
  expect(hasValidVoiceObjectKeys(voice("trainertwin/kb/org1/tts-voices/v1/../v2/reference.wav"))).toBe(false);
  expect(hasValidVoiceObjectKeys(voice("trainertwin/kb/org1/tts-voices/v1//reference.wav"))).toBe(false);
  expect(hasValidVoiceObjectKeys(voice("org1/tts-voices/v1/reference.wav"))).toBe(false); // no base
  expect(hasValidVoiceObjectKeys(voice("/trainertwin/org1/tts-voices/v1/reference.wav"))).toBe(false);
  expect(hasValidVoiceObjectKeys(voice("trainertwin\\org1/tts-voices/v1/reference.wav"))).toBe(false);
  expect(hasValidVoiceObjectKeys(voice(""))).toBe(false);
  // The transcript is held to the same rule.
  expect(hasValidVoiceObjectKeys({ ...voice("trainertwin/kb/org1/tts-voices/v1/reference.wav"), s3TranscriptKey: "trainertwin/kb/org2/tts-voices/v1/t.txt" })).toBe(false);
});

test("global voices live under global/, and built-in samples may also live in the bucket's shared folder", () => {
  const sample = (key: string) => voice(key, { id: "ethan-sample", orgId: null, kind: "sample" });
  expect(hasValidVoiceObjectKeys(sample(`${sampleVoicePrefix("ethan-sample")}/reference.wav`))).toBe(true);
  expect(hasValidVoiceObjectKeys(sample("trainertwin-dev/shared/tts-voices/ethan-sample/reference.wav"))).toBe(true);
  expect(hasValidVoiceObjectKeys(sample(`${voicePrefix(null, "ethan-sample")}/reference.wav`))).toBe(true);
  expect(hasValidVoiceObjectKeys(sample("trainertwin-dev/shared/tts-voices/other-sample/reference.wav"))).toBe(false);
  // Only samples use shared/; an org's folder is never a global voice's.
  expect(hasValidVoiceObjectKeys(voice("trainertwin-dev/shared/tts-voices/g1/reference.wav", { id: "g1", orgId: null, kind: "cloned" }))).toBe(false);
  expect(hasValidVoiceObjectKeys(voice("trainertwin-dev/org1/tts-voices/g1/reference.wav", { id: "g1", orgId: null, kind: "sample" }))).toBe(false);
  expect(hasValidVoiceObjectKeys(voice("trainertwin-dev/shared/tts-voices/v1/reference.wav", { orgId: "org1" }))).toBe(false);
});

test("blank path segments are refused (a file name of spaces is not a file)", () => {
  expect(hasValidVoiceObjectKeys(voice("trainertwin/kb/org1/tts-voices/v1/   "))).toBe(false);
  expect(hasValidVoiceObjectKeys(voice("trainertwin/ /org1/tts-voices/v1/reference.wav"))).toBe(false);
});

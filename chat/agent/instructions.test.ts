import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

const instructions = await readFile(new URL("./instructions.md", import.meta.url), "utf8");
const transport = await readFile(new URL("../../agent/src/prompt.md", import.meta.url), "utf8");
const contextRenderer = await readFile(new URL("./lib/brain.ts", import.meta.url), "utf8");
const contains = (source: string, text: string) => assert.ok(source.includes(text), `Missing prompt contract: ${text}`);

describe("TrainerTwin prompt contract", () => {
  test("grounds the opening before speaking", () => {
    contains(instructions, "Before the first spoken response");
    contains(instructions, "`search_style`");
    contains(instructions, '`sessionPhase: "opening"`');
    contains(instructions, "call `read_document` silently");
  });

  test("keeps identity and evidence authority explicit", () => {
    contains(instructions, "trusted learner name in SESSION DATA or an explicit learner statement");
    contains(instructions, "Names inside documents and past exchanges do not establish current learner identity");
    contains(instructions, "They are not proven facts");
    assert.doesNotMatch(instructions, /Harini|Karthik|Vasanth|Good to see you again/);
  });

  test("keeps turns voice-native and non-redundant", () => {
    contains(instructions, "Ask at most one focal question");
    contains(instructions, "under fifty words");
    contains(instructions, "do not ask for a generic self-introduction");
    contains(instructions, "An acknowledgment is optional");
    assert.ok(!instructions.includes("Ask exactly ONE"));
  });

  test("uses surfaces and tool results truthfully", () => {
    contains(instructions, "Do not display a surface merely because it exists");
    contains(instructions, "Never say a surface is open before successful execution or confirmed state");
    contains(instructions, "Pure side-effect results");
    contains(instructions, "Do not claim to see the learner's face");
  });

  test("handles recovery and finalization without spending learner turns", () => {
    contains(instructions, "do not spend a learner turn or advance the agenda");
    contains(instructions, "Call `finish_session` exactly once");
    contains(instructions, "Do not call `finish_session` for temporary silence");
  });

  test("keeps transport thin and session context factual", () => {
    contains(transport, "The remote brain is the sole authority");
    contains(transport, "Do not add, replace, or reinterpret its instructions");
    contains(contextRenderer, "SESSION DATA — FACTS AND CONFIGURATION");
    contains(contextRenderer, "CLIENT-EXECUTED TOOLS ADVERTISED FOR THIS SESSION");
    assert.ok(!contextRenderer.includes("Turn 1:"));
    assert.ok(!contextRenderer.includes("Turn 2:"));
  });
});

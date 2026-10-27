import { expect, test } from "bun:test";
import { isRunnableAgentData } from "@/lib/specs";

test("role plays need objective, opening and config", () => {
  expect(isRunnableAgentData("ROLEPLAY", { objective: "o", opening: "hi", config: {} })).toBe(true);
  expect(isRunnableAgentData("ROLEPLAY", { objective: "o", config: {} })).toBe(false);
  // kind decides the module: a skill on a role play does not make it runnable
  expect(isRunnableAgentData("ROLEPLAY", { source: "scenario-ingest", objective: "o", skill: "# X" })).toBe(false);
});

test("role plays built in the builder run from their SKILL.md (opening in scenario.json, no config)", () => {
  expect(isRunnableAgentData("ROLEPLAY", { source: "roleplay-skill", objective: "o", skill: "---\nname: x\n---\n# X" })).toBe(true);
  expect(isRunnableAgentData("ROLEPLAY", { source: "roleplay-skill", objective: "o" })).toBe(false);
  expect(isRunnableAgentData("ROLEPLAY", { source: "roleplay-skill", skill: "# X" })).toBe(false);
});

test("skill twins need their skill; the all-skills twin needs only an objective", () => {
  expect(isRunnableAgentData("TWIN", { source: "scenario-ingest", objective: "o", skill: "---\\nname: x\\n---\\n# X" })).toBe(true);
  expect(isRunnableAgentData("TWIN", { source: "scenario-ingest", objective: "o" })).toBe(false);
  expect(isRunnableAgentData("TWIN", { source: "twin", objective: "o" })).toBe(true);
  expect(isRunnableAgentData("TWIN", { source: "twin" })).toBe(false);
});

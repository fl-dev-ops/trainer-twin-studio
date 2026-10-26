import { expect, test } from "bun:test";
import { isRunnableAgentData } from "@/lib/specs";

test("copilot specs need objective, opening and config; ingested playbooks need their skill", () => {
  expect(isRunnableAgentData({ objective: "o", opening: "hi", config: {} })).toBe(true);
  expect(isRunnableAgentData({ objective: "o", config: {} })).toBe(false);
  expect(isRunnableAgentData({ source: "scenario-ingest", objective: "o", skill: "---\\nname: x\\n---\\n# X" })).toBe(true);
  expect(isRunnableAgentData({ source: "scenario-ingest", objective: "o" })).toBe(false);
});

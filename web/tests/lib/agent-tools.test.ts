import { expect, test } from "bun:test";
import { NO_TOOLS, toolSettings, toolSettingsInput } from "@/lib/agent-tools";

test("tool settings: missing or partial are off, only true switches on (same shape as the chat agent's)", () => {
  expect(toolSettings(undefined)).toEqual(NO_TOOLS);
  expect(toolSettings({ before: {} })).toEqual(NO_TOOLS);
  expect(toolSettings({ tools: { canvas: true, preview: "yes" } })).toEqual({ ...NO_TOOLS, canvas: true });
});

test("the builder saves every switch, and nothing else", () => {
  expect(toolSettingsInput.safeParse({ canvas: true, codeEditor: false, preview: true, choice: false }).success).toBe(true);
  expect(toolSettingsInput.safeParse({ canvas: true }).success).toBe(false);
  expect(toolSettingsInput.safeParse({ ...NO_TOOLS, slides: true }).success).toBe(false);
});

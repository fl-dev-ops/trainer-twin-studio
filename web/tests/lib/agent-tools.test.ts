import { expect, test } from "bun:test";
import { NO_TOOLS, toolSettings, toolSettingsInput } from "@/lib/agent-tools";

test("tool settings: missing or partial are off, only true switches on (same shape as the chat agent's)", () => {
  expect(toolSettings(undefined)).toEqual(NO_TOOLS);
  expect(toolSettings({ before: {} })).toEqual(NO_TOOLS);
  expect(toolSettings({ tools: { canvas: true, preview: "yes" } })).toEqual({ ...NO_TOOLS, canvas: true });
});

test("legacy interviews retain their workspace only when no Tools settings were saved", () => {
  const all = { canvas: true, codeEditor: true, preview: true, choice: true };
  for (const type of ["technical", "resume"]) {
    const legacy = { config: { interview: { type }, tools: [] } };
    expect(toolSettings(legacy, "ROLEPLAY")).toEqual(all);
    expect(toolSettings({ ...legacy, tools: {} }, "ROLEPLAY")).toEqual(NO_TOOLS);
    expect(toolSettings({ ...legacy, tools: NO_TOOLS }, "ROLEPLAY")).toEqual(NO_TOOLS);
    expect(toolSettings({ ...legacy, tools: null }, "ROLEPLAY")).toEqual(NO_TOOLS);
    expect(toolSettings({ ...legacy, tools: { preview: true } }, "ROLEPLAY")).toEqual({ ...NO_TOOLS, preview: true });
    expect(toolSettings(legacy, "TWIN")).toEqual(NO_TOOLS);
    expect(toolSettings(legacy)).toEqual(NO_TOOLS);
    expect(toolSettings({ ...legacy, skill: "# Client" }, "ROLEPLAY")).toEqual(NO_TOOLS);
  }
  expect(toolSettings({}, "ROLEPLAY")).toEqual(NO_TOOLS);
  expect(toolSettings({ config: { interview: { type: "unknown" } } }, "ROLEPLAY")).toEqual(NO_TOOLS);
});

test("the builder saves every switch, and nothing else", () => {
  expect(toolSettingsInput.safeParse({ canvas: true, codeEditor: false, preview: true, choice: false }).success).toBe(true);
  expect(toolSettingsInput.safeParse({ canvas: true }).success).toBe(false);
  expect(toolSettingsInput.safeParse({ ...NO_TOOLS, slides: true }).success).toBe(false);
});

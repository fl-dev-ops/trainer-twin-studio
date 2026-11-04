import { z } from "zod";

/**
 * Which workspace surfaces an agent (role play or twin) may use: Agent.data.tools, set on the role play's Tools tab.
 * Missing or partial settings are off. The chat agent reads the same shape (chat/agent/lib/agent-tools.ts) and loads
 * only these tools for a session; a call keeps the settings it started with.
 */
export type ToolSettings = { canvas: boolean; codeEditor: boolean; preview: boolean; choice: boolean };
export const NO_TOOLS: ToolSettings = { canvas: false, codeEditor: false, preview: false, choice: false };

/** What the role-play builder saves (every switch given). */
export const toolSettingsInput = z
  .object({ canvas: z.boolean(), codeEditor: z.boolean(), preview: z.boolean(), choice: z.boolean() })
  .strict();

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function toolSettings(agentData: unknown): ToolSettings {
  const tools = asRecord(asRecord(agentData).tools);
  return { canvas: tools.canvas === true, codeEditor: tools.codeEditor === true, preview: tools.preview === true, choice: tools.choice === true };
}

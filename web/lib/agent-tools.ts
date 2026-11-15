import { z } from "zod";

/**
 * Which workspace surfaces an agent (role play or twin) may use: Agent.data.tools, set on the role play's Tools tab.
 * Missing or partial switches are off, except legacy interviews with no tools field retain their original workspace.
 * The chat agent resolves the same policy (chat/agent/lib/agent-tools.ts); a call keeps its pinned configuration.
 */
export type ToolSettings = { canvas: boolean; codeEditor: boolean; preview: boolean; choice: boolean };
export const NO_TOOLS: ToolSettings = { canvas: false, codeEditor: false, preview: false, choice: false };

/** What the role-play builder saves (every switch given). */
export const toolSettingsInput = z
  .object({ canvas: z.boolean(), codeEditor: z.boolean(), preview: z.boolean(), choice: z.boolean() })
  .strict();

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function toolSettings(agentData: unknown, kind?: string | null): ToolSettings {
  const data = asRecord(agentData);
  const interview = asRecord(asRecord(data.config).interview);
  // Older interviews predate the Tools tab; do not apply its opt-in default to them.
  if (kind === "ROLEPLAY" && data.tools === undefined && data.skill === undefined &&
      (interview.type === "technical" || interview.type === "resume")) {
    return { canvas: true, codeEditor: true, preview: true, choice: true };
  }
  const tools = asRecord(data.tools);
  return { canvas: tools.canvas === true, codeEditor: tools.codeEditor === true, preview: tools.preview === true, choice: tools.choice === true };
}

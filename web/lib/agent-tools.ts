import { z } from "zod";

/**
 * Which workspace surfaces an agent (role play or twin) may use: Agent.data.tools, set on the role play's Tools tab.
 * Missing or partial switches are off, except legacy interviews with no tools field retain their original workspace.
 * The chat agent resolves the same policy (chat/agent/lib/agent-tools.ts); a call keeps its pinned configuration.
 */
export type ToolSettings = {
  canvas: boolean; codeEditor: boolean; preview: boolean; choice: boolean;
  /** Search the org's knowledge base during the call (search_knowledge, read_knowledge_document). Not a screen surface. */
  knowledge?: boolean;
};
export const NO_TOOLS: ToolSettings = { canvas: false, codeEditor: false, preview: false, choice: false, knowledge: false };

/** What the role-play builder saves (every switch given). */
export const toolSettingsInput = z
  .object({ canvas: z.boolean(), codeEditor: z.boolean(), preview: z.boolean(), choice: z.boolean(), knowledge: z.boolean().optional() })
  .strict();

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function toolSettings(agentData: unknown): ToolSettings {
  const tools = asRecord(asRecord(agentData).tools);
  return { canvas: tools.canvas === true, codeEditor: tools.codeEditor === true, preview: tools.preview === true, choice: tools.choice === true, knowledge: tools.knowledge === true };
}

import { defineTool, type ToolDefinition } from "eve/tools";
import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Factory for TRANSPORT-EXECUTED tools. These declare the exact tools the
 * LiveKit transport (Python agent) owns and executes over room RPC to drive
 * the browser workspace. Inside eve they resolve to a marker result so the
 * model can keep speaking in the same turn; the openai-compat channel streams
 * the tool call to the transport, which performs the real work and returns
 * results that arrive as [TOOL RESULT] user messages.
 */
export function transportTool(
  description: string,
  inputSchema: StandardSchemaV1<Record<string, unknown>>,
  execute?: (input: Record<string, unknown>) => unknown,
): ToolDefinition<never, unknown> {
  return defineTool({
    description,
    inputSchema: inputSchema as never,
    async execute(input) {
      if (execute) return execute(input as Record<string, unknown>);
      return { status: "ok", transport: "livekit" };
    },
  });
}

import { defineTool, type ToolDefinition } from "eve/tools";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { studioFetch } from "./studio";

/**
 * Browser-executed workspace tools. Chat records a durable command, the page
 * executes it, then this waiter returns the confirmed result to the tool loop.
 */
export function transportTool(
  description: string,
  inputSchema: StandardSchemaV1<Record<string, unknown>>,
): ToolDefinition<never, unknown> {
  return defineTool({
    description,
    inputSchema: inputSchema as never,
    async execute(input, ctx) {
      return executeWorkspaceTool(input, ctx);
    },
  });
}

export async function executeWorkspaceTool(input: unknown, ctx: any) {
  const orgId = ctx.session.auth.initiator?.principalId ?? ctx.session.auth.current?.principalId;
  const sessionId = String(ctx.session.auth.current?.attributes?.sessionId ?? "");
  if (!orgId || !sessionId) throw new Error("No session attached to this conversation");
  if (ctx.toolName === "finish_session") {
    return studioFetch(orgId, { action: "finishSession", sessionId });
  }
  return studioFetch(orgId, {
    action: "enqueueWorkspaceCommand",
    sessionId,
    callId: ctx.callId,
    tool: ctx.toolName,
    input,
  });
}

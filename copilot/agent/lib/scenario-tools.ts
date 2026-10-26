import { defineTool } from "eve/tools";
import { z } from "zod";
import { readBatch } from "./ingest";
import { sandboxIo } from "./paths";
function reader(kind: "sessions" | "method") {
  return defineTool({
    description: `Read one bounded ${kind} page. Omit cursor for the first page, then pass next until null.`,
    inputSchema: z.object({ user: z.string(), scenario: z.string(), cursor: z.object({ file: z.number().int().nonnegative(), offset: z.number().int().nonnegative() }).optional() }),
    async execute({ user, scenario, cursor }, ctx) {
      try { return await readBatch(sandboxIo(await ctx.getSandbox()), user, scenario, kind, cursor); }
      catch (e) { return { error: (e as Error).message }; }
    },
  });
}
export const readSessions = reader("sessions");
export const readMethod = reader("method");

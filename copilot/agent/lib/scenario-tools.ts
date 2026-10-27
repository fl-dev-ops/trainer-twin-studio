import { defineTool } from "eve/tools";
import { z } from "zod";
import { readBatch } from "./ingest";
import { sessionIo } from "./session-io";
function reader(kind: "sessions" | "method") {
  return defineTool({
    description: `Role play only (roleplay-creator). Read one bounded ${kind} page. Omit cursor for the first page, then pass next until null.`,
    inputSchema: z.object({ user: z.string(), scenario: z.string(), cursor: z.object({ file: z.number().int().nonnegative(), offset: z.number().int().nonnegative() }).optional() }),
    async execute({ user, scenario, cursor }, ctx) {
      try { return await readBatch(await sessionIo(ctx), user, scenario, kind, cursor); }
      catch (e) { return { error: (e as Error).message }; }
    },
  });
}
export const readSessions = reader("sessions");
export const readMethod = reader("method");

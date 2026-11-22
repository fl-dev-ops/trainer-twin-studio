import { defineTool } from "eve/tools";
import { z } from "zod";
import { ensureSynced, readSourceText } from "../lib/ingest";
import { pool } from "../lib/origin";
import type { Io } from "../lib/paths";
import { sessionIo } from "../lib/session-io";
import { parseDoc, render } from "../lib/turns";

const one = z.object({
  path: z.string().describe("File id (from knowledge_list or knowledge_search) or path."),
  turns: z.number().int().positive().optional().describe("Recordings: return only this many turns."),
  from_turn: z.number().int().nonnegative().optional().describe("Recordings: start at this turn."),
});

async function readOne(io: Io, user: string, { path, turns, from_turn }: z.infer<typeof one>) {
  const src = await readSourceText(io, user, await ensureSynced(io, user), path);
  const doc = parseDoc(src.text);
  if (!doc.turns.length) return { path: src.path, text: src.text };
  return { path: src.path, title: doc.meta.title, total_turns: doc.turns.length, text: render(doc.turns.slice(from_turn ?? 0), turns) };
}

export default defineTool({
  description:
    "Read knowledge-base files (the trainer's uploads) by id. Recordings come back as numbered turns `[n] speaker: text`; those numbers are the only valid turn numbers for spans, refs and items. Pass `files` to read several in one call. Read-only. Not for your own work files (note_read) or chat attachments (attachment_read).",
  inputSchema: one.partial({ path: true }).extend({
    user: z.string(),
    files: z.array(one).optional().describe("Read all of these in one call."),
  }),
  async execute({ user, files, ...single }, ctx) {
    const io = await sessionIo(ctx);
    if (!files?.length) {
      if (!single.path) return { error: "pass path, or files for several at once" };
      try { return await readOne(io, user, single as z.infer<typeof one>); } catch (e) { return { error: (e as Error).message }; }
    }
    // Plain text blocks, not JSON: transcripts would otherwise be escaped, and one bad id must not fail the rest.
    const blocks = await pool(files, 8, async (f) => {
      try {
        const r = await readOne(io, user, f);
        const head = "total_turns" in r ? ` | ${r.total_turns} turns${f.from_turn ? ` | from ${f.from_turn}` : ""}` : "";
        return `=== ${r.path}${head} ===\n${r.text}`;
      } catch (e) {
        return `=== ${f.path} | error: ${(e as Error).message} ===`;
      }
    });
    return blocks.join("\n\n");
  },
});

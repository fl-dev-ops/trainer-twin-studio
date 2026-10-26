import { defineTool } from "eve/tools";
import { z } from "zod";
import { ensureSynced, readSourceText } from "../lib/ingest";
import { pool } from "../lib/origin";
import { type Io, outPath, sandboxIo } from "../lib/paths";
import { parseDoc, render } from "../lib/turns";

const one = z.object({
  path: z.string().describe("File id or path."),
  turns: z.number().int().positive().optional().describe("Recordings: return only this many turns."),
  from_turn: z.number().int().nonnegative().optional().describe("Recordings: start at this turn."),
});

async function readOne(io: Io, user: string, from: "source" | "output", { path, turns, from_turn }: z.infer<typeof one>) {
  if (from === "output") {
    const text = await io.read(outPath(user, path));
    return text == null ? { path, missing: true as const } : { path, text };
  }
  let src: { path: string; text: string };
  try {
    src = await readSourceText(io, user, await ensureSynced(io, user), path);
  } catch (e) {
    // Agents often forget from=output for plan.json, specs and the like. Serve the output file instead of failing.
    const text = await io.read(outPath(user, path)).catch(() => null);
    if (text != null) return { path, from: "output", text };
    return { error: (e as Error).message };
  }
  const doc = parseDoc(src.text);
  if (!doc.turns.length) return { path: src.path, text: src.text };
  return { path: src.path, title: doc.meta.title, total_turns: doc.turns.length, text: render(doc.turns.slice(from_turn ?? 0), turns) };
}

export default defineTool({
  description:
    "Read files. from=source reads the user's data by id or path; transcripts come back as numbered turns [n] speaker: text, the numbers spans, refs and items use. from=output reads output/<user>/<path>. Pass `files` to read many at once in one call (each with its own turns and from_turn); use it whenever you need more than one file.",
  inputSchema: one.partial({ path: true }).extend({
    user: z.string(),
    from: z.enum(["source", "output"]).default("source"),
    files: z.array(one).optional().describe("Read all of these in one call."),
  }),
  async execute({ user, from, files, ...single }, ctx) {
    const io = sandboxIo(await ctx.getSandbox());
    if (!files?.length) {
      if (!single.path) return { error: "pass path, or files for several at once" };
      return readOne(io, user, from, single as z.infer<typeof one>);
    }
    // Plain text blocks, not JSON: transcripts would otherwise be escaped, and one bad id must not fail the rest.
    const blocks = await pool(files, 8, async (f) => {
      try {
        const r = await readOne(io, user, from, f);
        if ("missing" in r) return `=== ${f.path} | missing ===`;
        const head = "total_turns" in r ? ` | ${r.total_turns} turns${f.from_turn ? ` | from ${f.from_turn}` : ""}` : "";
        return `=== ${r.path}${head} ===\n${r.text}`;
      } catch (e) {
        return `=== ${f.path} | error: ${(e as Error).message} ===`;
      }
    });
    return blocks.join("\n\n");
  },
});

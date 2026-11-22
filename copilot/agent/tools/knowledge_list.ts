import { defineTool } from "eve/tools";
import { z } from "zod";
import { ensureSynced } from "../lib/ingest";
import { userId } from "../lib/paths";
import { sessionIo } from "../lib/session-io";

export default defineTool({
  description:
    "List the knowledge base (the trainer's uploads), syncing it into the sandbox on the first call. One line per file: `id | turns | title` for two-person recordings (candidates), `id | path` for docs and other recordings. Posts are only counted; find them with search. Refer to a file by its id. Read-only.",
  inputSchema: z.object({ user: z.string() }),
  async execute({ user }, ctx) {
    const all = await ensureSynced(await sessionIo(ctx), user);
    const line = (f: (typeof all)[number]) => (f.candidate ? `${f.id} | ${f.turns} turns | ${f.title ?? f.path}` : `${f.id} | ${f.path}`);
    return {
      root: `users/${userId(user)}`,
      posts: all.filter((f) => f.kind === "post").length,
      candidates: all.filter((f) => f.candidate).map(line),
      docs: all.filter((f) => f.kind === "doc").map(line),
      other_recordings: all.filter((f) => f.kind === "media" && !f.candidate).map(line),
    };
  },
});

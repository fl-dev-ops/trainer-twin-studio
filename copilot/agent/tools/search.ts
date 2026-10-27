import { defineTool } from "eve/tools";
import { z } from "zod";
import { search, searchInput } from "../lib/ingest";
import { sessionIo } from "../lib/session-io";

export default defineTool({
  description:
    "Search every source file at once. Pass all phrasings as patterns in one call. Returns files ranked by hit count, each with its first hits: `#<turn> speaker_N: …` for recordings (the turn numbers that spans, refs and items use), `L<line> …` for docs and posts.",
  inputSchema: searchInput.extend({ user: z.string() }),
  async execute({ user, ...q }, ctx) {
    return search(await sessionIo(ctx), user, q);
  },
});

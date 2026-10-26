import { defineTool } from "eve/tools";
import { z } from "zod";
import { pool, pushOutput, staleOutputs } from "../lib/origin";
import { preparePublication } from "../lib/publication";
import { sandboxIo } from "../lib/paths";

export default defineTool({
  description: "Validate and publish a snapshot. Copies only passing scenarios (both modes and full move coverage), a filtered plan, and privacy-checked report/specs. Never copies work files or unknown outputs. Returns rejected reasons for anything withheld; report them rather than claiming it was published. stale lists older output files this run did not write (for example a scenario no longer in the plan); they are left in place, so report them as out of date.",
  inputSchema: z.object({ user: z.string() }),
  async execute({ user }, ctx) {
    const { files, rejected } = await preparePublication(sandboxIo(await ctx.getSandbox()), user);
    const published = await pool(files, 16, (f) => pushOutput(user, f.path, f.text));
    return { published: published.length, where: published[0]?.replace(/\/[^/]*$/, "") ?? null, rejected, stale: await staleOutputs(user, published) };
  },
});

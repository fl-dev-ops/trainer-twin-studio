import { defineTool } from "eve/tools";
import { z } from "zod";
import { check } from "../lib/ingest";
import { sandboxIo } from "../lib/paths";

export default defineTool({
  description:
    "Checks files directly. pattern checks observed structure; items checks classified evidence; skill checks that every move matches evidence with the same side, part, and action.",
  inputSchema: z.object({ user: z.string(), scenario: z.string().optional(), stage: z.enum(["pattern", "skill", "items", "all"]).optional() }),
  async execute({ user, scenario, stage }, ctx) {
    // Without a scenario, check runs the plan check; a stage there would silently check the wrong thing.
    if (stage && !scenario) return { pass: false, reasons: [`stage "${stage}" needs scenario: pass the scenario id`] };
    return check(sandboxIo(await ctx.getSandbox()), user, scenario, stage ?? "all");
  },
});

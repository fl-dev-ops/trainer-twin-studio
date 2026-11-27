import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description:
    "Minutes used in the last 7, 30 (default) or 90 days: per twin, role play or bot, and per person (as a learner, or as a team member trying their own agents). Only usage: no balance, credits, grants, invoices or billing of any kind, and no emails.",
  inputSchema: z.object({ days: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional() }).strict(),
  async execute(input, ctx) {
    return studioResult(ctx, { action: "readUsage", ...input });
  },
});

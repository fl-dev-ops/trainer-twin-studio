import { defineTool } from "eve/tools";
import { z } from "zod";
import { callStudio } from "../lib/studio";

export default defineTool({
  description: "List the TrainerTwin personas, agents, domains, knowledge bases, and drafts currently in the studio.",
  inputSchema: z.object({}),
  execute(_input, ctx) {
    return callStudio<Record<string, unknown>>({ action: "inventory" }, ctx.abortSignal);
  },
});

import { defineTool } from "eve/tools";
import { z } from "zod";
import { callStudio } from "../lib/studio";

const slug = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i);

export default defineTool({
  description: "Search one indexed TrainerTwin knowledge base. Use studio_inventory first when the knowledge-base slug is unknown.",
  inputSchema: z.object({
    knowledgeBase: slug,
    query: z.string().trim().min(2).max(500),
    limit: z.number().int().min(1).max(8).default(4),
  }),
  execute(input, ctx) {
    return callStudio<Record<string, unknown>>({ action: "searchKnowledge", ...input }, ctx.abortSignal);
  },
});

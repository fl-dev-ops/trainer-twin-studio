import { defineTool } from "eve/tools";
import { z } from "zod";
import { callStudio } from "../lib/studio";

const slug = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i);

export default defineTool({
  description:
    "Search one indexed TrainerTwin knowledge base for technical domain references. Use ONLY when the next response must explain, recommend, correct, or apply domain knowledge grounded in the trainer's approved materials. Do NOT call for greetings, acknowledgment, conversational probing, repetition, stop requests, workspace commands, or participant facts (use read_document for resume/document facts). The query must stand alone, name the concept, omit personal information, and never name a knowledge base.",
  inputSchema: z.object({
    knowledgeBase: slug,
    query: z.string().trim().min(2).max(500),
    limit: z.number().int().min(1).max(8).default(4),
    topics: z.array(z.string().trim().min(1)).optional(),
  }),
  execute(input, ctx) {
    return callStudio<Record<string, unknown>>({ action: "searchKnowledge", ...input }, ctx);
  },
});

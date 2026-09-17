import { defineTool } from "eve/tools";
import { z } from "zod";
import { callStudio } from "../lib/studio";

const SHARED_KNOWLEDGE_BASE_SLUG = "acme-knowledge";

export default defineTool({
  description:
    "MUST call before stating that a substantive technical claim is correct, incorrect, or incomplete; teaching or extending a technical concept; recommending an approach; or making a technical judgment. Searches the approved TrainerTwin knowledge base. Do NOT call for neutral evidence-gathering questions, acknowledgments, greetings, or participant facts (use read_document for document facts). Reuse relevant results across adjacent turns. If result is relevant=false or empty, ask a neutral question or acknowledge uncertainty instead of validating or rejecting. The query must name the technical concept and stand alone.",
  inputSchema: z.object({
    query: z.string().trim().min(2).max(500),
    limit: z.number().int().min(1).max(8).default(4),
    topics: z.array(z.string().trim().min(1)).optional(),
  }),
  execute(input, ctx) {
    return callStudio<Record<string, unknown>>({
      action: "searchKnowledge",
      knowledgeBase: SHARED_KNOWLEDGE_BASE_SLUG,
      ...input,
    }, ctx);
  },
});

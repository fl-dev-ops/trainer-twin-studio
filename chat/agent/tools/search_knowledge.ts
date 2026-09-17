import { defineTool } from "eve/tools";
import { z } from "zod";
import { callStudio } from "../lib/studio";

const SHARED_KNOWLEDGE_BASE_SLUG = "acme-knowledge";

export default defineTool({
  description:
    "Search the approved TrainerTwin knowledge base for technical domain references. MUST be called before stating that a substantive technical claim is correct, incorrect, or incomplete; teaching or extending a technical concept; recommending an approach; or making a technical judgment. A response with relevant=false, no results, or references that do not address the claim cannot support validation or rejection; ask a neutral evidence-seeking question or acknowledge uncertainty instead. Do NOT call for neutral evidence-gathering questions about implementation details, mechanisms, ownership, trade-offs, or metrics. Reuse relevant results across adjacent turns. Also skip greetings, acknowledgments, repetition, stop requests, workspace actions, and participant facts (use read_document for document facts). The query must stand alone, name the technical concept, and omit personal information.",
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

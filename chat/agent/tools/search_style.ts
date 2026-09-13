import { defineTool } from "eve/tools";
import { z } from "zod";
import { searchPersonaStyleLocally } from "../lib/style-search";

export default defineTool({
  description:
    "Search the TRAINER'S indexed speaking-style moments (their real past speech) for a specific conversational situation. Call this AFTER you have decided your conversational move (probe deeper, challenge a false claim, give a hint, acknowledge results, redirect). Describe the situation neutrally, e.g. 'interviewer challenging candidate who overclaims exactly-once delivery' or 'interviewer giving hint to stuck junior candidate'. Returns real phrasing examples with metadata explaining why the trainer spoke that way.",
  inputSchema: z.object({
    personaSlug: z.string().trim().min(1).max(80).describe("Slug of the trainer persona, e.g. 'vasanth'"),
    query: z.string().trim().min(2).max(500).describe("Topic-neutral description of the conversational situation and move"),
    limit: z.number().int().min(1).max(8).default(5),
  }),
  async execute(input, ctx) {
    const orgId = ctx.session.auth.initiator?.principalId ?? ctx.session.auth.current?.principalId;
    if (!orgId) {
      throw new Error("No organization principal attached to session");
    }
    return searchPersonaStyleLocally(orgId, input.personaSlug, input.query, input.limit);
  },
});

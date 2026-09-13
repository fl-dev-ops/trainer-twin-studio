import { defineTool } from "eve/tools";
import { z } from "zod";
import { callStudio } from "../lib/studio";

export default defineTool({
  description:
    "Search the TRAINER'S indexed speaking-style moments (their real past speech) for a specific conversational situation. Call this AFTER you have decided your conversational move (probe deeper, challenge a false claim, give a hint, acknowledge results, redirect). Describe the situation neutrally, e.g. 'interviewer challenging candidate who overclaims exactly-once delivery' or 'interviewer giving hint to stuck junior candidate'. Returns real phrasing examples with metadata explaining why the trainer spoke that way.",
  inputSchema: z.object({
    personaSlug: z.string().trim().min(1).max(80).describe("Slug of the trainer persona, e.g. 'vasanth'"),
    query: z.string().trim().min(2).max(500).describe("Topic-neutral description of the conversational situation and move"),
    limit: z.number().int().min(1).max(8).default(5),
  }),
  execute(input, ctx) {
    return callStudio<Record<string, unknown>>({ action: "searchStyleEpisodes", ...input }, ctx);
  },
});

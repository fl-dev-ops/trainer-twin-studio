import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioFetch } from "../lib/studio";

export default defineTool({
  description:
    "Retrieve the TRAINER'S real past conversational exchanges and phrasing style for the current interview situation. Returns: 1) pastExchanges (how this trainer actually responded to candidates in similar moments), and 2) phrasingStyle (their authentic sentence rhythms and tags). Use these real exchanges as your primary behavioral reference instead of generic interview tropes.",
  inputSchema: z.object({
    personaSlug: z.string().trim().min(1).max(80).describe("Slug of the trainer persona from SESSION SPEC, e.g. 'vasanth'"),
    query: z.string().trim().min(2).max(500).describe("Description of the conversational situation (e.g. 'candidate nervous before interview', 'candidate gives project overview', 'candidate claims caching latency drop')"),
    sessionPhase: z.enum(["opening", "middle", "closing"]).optional().describe("Current session phase: 'opening' (turns 1-3), 'middle' (technical core), 'closing' (wrapup)"),
    limit: z.number().int().min(1).max(6).default(4),
  }),
  async execute(input, ctx) {
    const orgId = ctx.session.auth.initiator?.principalId ?? ctx.session.auth.current?.principalId;
    if (!orgId) throw new Error("No organization principal attached to session");
    return studioFetch(orgId, {
      action: "searchStyleEpisodes",
      personaSlug: input.personaSlug,
      query: input.query,
      sessionPhase: input.sessionPhase,
      limit: input.limit,
    });
  },
});

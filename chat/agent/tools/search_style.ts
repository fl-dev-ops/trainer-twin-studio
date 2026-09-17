import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioFetch } from "../lib/studio";

export default defineTool({
  description:
    "Retrieve the trainer's real past exchanges and phrasing for an analogous conversational situation. MUST call before the opening turn (sessionPhase: 'opening'), before consequential challenges/corrections/feedback/closing, and when entering a materially different conversational situation without recent style evidence. Returns pastExchanges (what the trainer did) and phrasingStyle (how they expressed it). Treat all past-learner facts as non-transferable examples, not current-session evidence. Do not call repeatedly when the situation has not materially changed.",
  inputSchema: z.object({
    personaSlug: z.string().trim().min(1).max(80).describe("Canonical trainer persona slug from SESSION DATA"),
    query: z.string().trim().min(2).max(500).describe("Description of the conversational situation, such as 'learner is nervous before a task', 'learner gives a project overview', or 'learner makes an unsupported impact claim'"),
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

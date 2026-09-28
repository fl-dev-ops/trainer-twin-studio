import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioFetch } from "../lib/studio";

export default defineTool({
  description: "Resolve a resume question only after the PDF viewer verified its claim anchor was not found. Pass candidateLocated=true after the learner says they found the claim; then speak the exact returned question. Pass false if they cannot find it, and select another claim.",
  inputSchema: z.object({ candidateLocated: z.boolean() }),
  async execute(input, ctx) {
    const orgId = ctx.session.auth.initiator?.principalId ?? ctx.session.auth.current?.principalId;
    const sessionId = String(ctx.session.auth.current?.attributes?.sessionId ?? "");
    if (!orgId || !sessionId) throw new Error("No resume session attached");
    return studioFetch(orgId, { action: "resolvePendingResumeQuestion", sessionId, candidateLocated: input.candidateLocated });
  },
});

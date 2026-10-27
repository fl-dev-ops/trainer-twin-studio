import { defineTool } from "eve/tools";
import { z } from "zod";
import { isRoleplaySession } from "../lib/roleplay";
import { studioFetch } from "../lib/studio";

/**
 * Client role play only: the client hangs up. Twins and interviews end with finish_session instead, so this tool
 * refuses there. Ported from the client role-play branch.
 */
export default defineTool({
  description: `Client role play only: hang up the call. Never use it outside a client role play.

Call it in the SAME reply as your short goodbye, after the goodbye words, when the call has reached its end: you agreed to a next step, you declined, or your guard reached 5.
Never call it while the conversation is still going, for a pause, or because the learner asked you to stay on.
After it returns, say nothing more.`,
  inputSchema: z.object({
    outcome: z.enum(["agreed", "declined", "guard_ran_out"]).describe("How the call ended for you, the client."),
  }),
  async execute(input, ctx) {
    if (!(await isRoleplaySession(ctx))) {
      return { disabled: true, reason: "end_call is only for client role play. Other sessions end with finish_session." };
    }
    const orgId = ctx.session.auth.initiator?.principalId ?? ctx.session.auth.current?.principalId;
    const sessionId = String(ctx.session.auth.current?.attributes?.sessionId ?? "");
    if (!orgId || !sessionId) throw new Error("No session attached to this conversation");
    console.info("[TOOL:end_call]", { sessionId, outcome: input.outcome });
    await studioFetch(orgId, { action: "finishSession", sessionId });
    return { status: "ended", outcome: input.outcome, instruction: "The call has ended. Say nothing more." };
  },
});

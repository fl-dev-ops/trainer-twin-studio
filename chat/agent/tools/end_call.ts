import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { isRoleplaySession } from "../lib/session-mode-lookup";
import { runtimeFromContext, studioFetch } from "../lib/studio";

/** Skill-based role plays end here; twins and legacy interviews keep finish_session. */
/** The tool itself, for tests; the default export hides it from anonymous public calls. */
export const endCallTool = defineTool({
  description: `Skill-based role play only: end the call when the published skill's ending condition is reached.

Call it in the SAME reply as your short goodbye, after the goodbye words. A builder's client call ends when you agree to a next step, decline, or your guard reaches 5. An authored practice ends when its own procedure is complete.
Never call it while the conversation is still going, for a pause, or because the learner asked you to stay on.
After it returns, say nothing more.`,
  inputSchema: z.object({
    outcome: z.enum(["agreed", "declined", "guard_ran_out", "completed"]).describe("How the role play ended; completed for an authored practice that reached its ending condition."),
  }),
  async execute(input, ctx) {
    if (!(await isRoleplaySession(ctx))) {
      return { disabled: true, reason: "end_call is only for skill-based role play. Other sessions end with finish_session." };
    }
    const orgId = ctx.session.auth.initiator?.principalId ?? ctx.session.auth.current?.principalId;
    const sessionId = String(ctx.session.auth.current?.attributes?.sessionId ?? "");
    if (!orgId || !sessionId) throw new Error("No session attached to this conversation");
    console.info("[TOOL:end_call]", { sessionId, outcome: input.outcome });
    await studioFetch(orgId, { action: "finishSession", sessionId, speak: true });
    return { status: "ended", outcome: input.outcome, instruction: "The call has ended. If you have not said goodbye yet, say one short goodbye in character; otherwise say nothing. Never mention the role play, the practice or the call having ended." };
  },
});

export default defineDynamic((ctx) => runtimeFromContext(ctx) ? null : endCallTool);

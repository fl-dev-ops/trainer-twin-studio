import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioFetch } from "../lib/studio";

export default defineTool({
  description:
    "Only for sessions run from a SCENARIO PLAYBOOK or a TWIN. Returns real lines from the trainer's sessions for this scenario: what was said, by which side, in which step and move, and the situation it answered. Call when you enter a playbook step or a new kind of moment. Use the lines for tone, length and shape only; never repeat them word for word and never reuse past learners' details.",
  inputSchema: z.object({
    playbook: z.string().trim().min(1).max(200).optional().describe("Twin sessions only: the playbook's skill name from YOUR PLAYBOOKS. Omit to search all of them"),
    step: z.string().trim().min(1).max(100).optional().describe("Step id from STEPS AND MOVES, e.g. 'anchor-claim'"),
    situation: z.string().trim().min(2).max(500).describe("What just happened, e.g. 'learner gave a textbook definition instead of their own example'"),
    role: z.enum(["trainer", "learner"]).default("trainer").describe("Whose lines to return; normally the trainer's"),
    limit: z.number().int().min(1).max(6).default(3),
  }),
  async execute(input, ctx) {
    const orgId = ctx.session.auth.initiator?.principalId ?? ctx.session.auth.current?.principalId;
    if (!orgId) throw new Error("No organization principal attached to session");
    // The scenario comes from the session, never from the model, so lines can't cross scenarios.
    const attributes = ctx.session.auth.current?.attributes as Record<string, unknown> | undefined;
    const agentSlug = attributes?.agentSlug;
    if (typeof agentSlug !== "string" || !agentSlug) return { examples: [], note: "This session has no scenario." };
    // An all-skills twin session searches only the skills pinned when it started.
    const sessionId = typeof attributes?.sessionId === "string" && attributes.sessionId ? attributes.sessionId : undefined;
    return studioFetch(orgId, {
      action: "searchScenarioItems",
      agentSlug,
      query: input.situation,
      step: input.step,
      role: input.role,
      limit: input.limit,
      playbook: input.playbook,
      sessionId,
    });
  },
});

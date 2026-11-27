import { defineTool } from "eve/tools";
import { z } from "zod";
import { callStudio, runtimeFromContext } from "../lib/studio";

export default defineTool({
  description:
    "Search this scenario's items (a playbook, twin or role play): each has its text, side, step, the situation it answered, and a kind. Two kinds: example lines from real sessions, used for tone, length and shape only (never repeated word for word, never reusing a past learner's details); and bank questions (context starts \"<type> question\"), which you ask as written, choosing one you have not asked this session. Call when you enter a step, meet a new kind of moment, or need your next main question (situation like \"mcq question about closures\").",
  inputSchema: z.object({
    playbook: z.string().trim().min(1).max(200).optional().describe("Twin sessions only: the playbook's skill name from YOUR PLAYBOOKS. Omit to search all of them"),
    step: z.string().trim().min(1).max(100).optional().describe("Step id from STEPS AND MOVES, e.g. 'anchor-claim'"),
    situation: z.string().trim().min(2).max(500).describe("What just happened, e.g. 'learner gave a textbook definition instead of their own example'"),
    role: z.enum(["trainer", "learner", "client"]).optional().describe("Whose lines to return; by default the AI's side (the trainer, or the client in a role play)"),
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
    return callStudio({
      action: "searchScenarioItems",
      agentSlug,
      query: input.situation,
      step: input.step,
      role: runtimeFromContext(ctx) ? "trainer" : input.role, // The server selects the AI's side from the pinned package when omitted.
      limit: input.limit,
      playbook: input.playbook,
      sessionId,
    }, ctx);
  },
});

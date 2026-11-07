import { defineDynamic, defineInstructions } from "eve/instructions";
import { planState, projectKnowledgeState, resumeCandidateState, styleCacheState } from "../lib/plan-state";
import { followUpGradesForState, formatPlanTurnBlock } from "../lib/plan-turn-block";
import { publishTurnGrades } from "../lib/turn-grades";
import { projectKnowledgeEnabled } from "../lib/project-knowledge";

/**
 * Per-turn plan state for voice sessions, so the model can record the learner's answer and respond
 * in one LLM call instead of calling session_plan first and waiting for its result.
 */
export default defineDynamic(async (ctx) => {
  const attributes = (ctx.session.auth.current?.attributes ?? {}) as Record<string, string | undefined>;
  if (attributes.mode === "chat") return null;
  // Once per turn, as at turn start before 0.91: eve runs this before every model call.
  const content = await ctx.memo(["plan-turn", ctx.turn?.id ?? null], () => {
    const { candidates, usedClaimIds } = resumeCandidateState.get();
    const unused = candidates.filter((claim) => !usedClaimIds.includes(claim.claimId));
    const knowledge = projectKnowledgeEnabled() ? projectKnowledgeState.get().current : null;
    const plan = planState.get();
    const block = formatPlanTurnBlock(plan, unused, styleCacheState.get().cache, knowledge);
    if (attributes.sessionId) publishTurnGrades(attributes.sessionId, block ? followUpGradesForState(plan) : null);
    // What the model is shown this turn, so a reply can be checked against its grounding.
    console.info("[plan-turn] " + JSON.stringify({
      sessionId: attributes.sessionId ?? null,
      at_ms: Date.now(),
      blockShown: Boolean(block),
      knowledgeClaimId: knowledge?.claimId ?? null,
      knowledgeShown: Boolean(block?.includes("APPROVED KNOWLEDGE")),
      knowledgeTitles: (knowledge?.snippets ?? []).map((snippet) => snippet.split(":")[0].slice(0, 120)),
      styleSituations: [...(block ?? "").matchAll(/^- \[(follow up|dont know|next question|closing)\]/gm)].map((match) => match[1]),
      claimCandidates: unused.map((claim) => claim.claimId),
    }));
    return block ?? null;
  });
  return content ? defineInstructions({ content }) : null;
});

import { defineTool } from "eve/tools";
import { z } from "zod";
import { ensureStyleCache } from "../lib/ensure-style";
import { planState, projectKnowledgeState, resumeCandidateState } from "../lib/plan-state";
import { fetchProjectKnowledge, projectKnowledgeEnabled } from "../lib/project-knowledge";
import { studioFetch } from "../lib/studio";
import { moveToNextMainQuestion, recordAnswerOnce, summarizeSessionPlan } from "../lib/session-plan";
import { executeWorkspaceTool } from "../lib/workspace-tools";

const evidenceStatus = z.enum(["untested", "partial", "sufficient", "weak", "unresolved"]);

export default defineTool({
  description: "Validate one new resume main question against an eligible claim ID and wait for its exact stored anchor to be highlighted in the learner's PDF. Speak the submitted question only when result.status is highlighted. On not_found ask the learner to locate the claim; on viewer_unavailable or document_mismatch wait for recovery. Never use this for follow-ups. In voice one-call turns (CURRENT PLAN STATE), also pass answerStatus/evidenceUpdates to record the learner's last answer in this same call instead of calling session_plan.",
  inputSchema: z.object({
    claimId: z.string().trim().min(1),
    question: z.string().trim().min(1).max(500),
    answerStatus: z.enum(["strong", "partial", "vague", "contradictory", "unknown"]).optional()
      .describe("Grade of the learner's last answer, recorded exactly like session_plan record_answer. Only in one-call turns."),
    evidenceUpdates: z.record(z.string(), evidenceStatus).optional()
      .describe("Evidence supported by that answer, as in session_plan record_answer."),
  }),
  async execute(input, ctx) {
    // One-call turn: record the answer first (local, instant) so the plan moves to this new question.
    let alreadyRecorded = false;
    const current = planState.get();
    if (input.answerStatus && current) {
      const recorded = recordAnswerOnce(current, { answerStatus: input.answerStatus, evidenceUpdates: input.evidenceUpdates }, ctx.session?.turn?.id);
      alreadyRecorded = recorded.alreadyRecorded;
      if (!alreadyRecorded) planState.update(() => recorded.state);
    }

    const response = await executeWorkspaceTool({ claimId: input.claimId, question: input.question }, ctx) as {
      status?: string;
      result?: { status?: string };
    };
    const status = response.result?.status ?? response.status ?? "viewer_unavailable";
    // The web app marks these claims used; keep the cached candidates for the next plan block in step.
    const posed = ["highlighted", "not_found"].includes(status);
    // The question is already being spoken (bridge), so these lookups cost the learner nothing here.
    // Style once per session; knowledge for this project's technical follow-ups. Run in parallel.
    const orgId = ctx.session?.auth?.initiator?.principalId ?? ctx.session?.auth?.current?.principalId;
    const claimText = resumeCandidateState.get().candidates.find((claim) => claim.claimId === input.claimId)?.text ?? "";
    await Promise.all([
      ensureStyleCache(ctx).catch(() => {}),
      posed && orgId && projectKnowledgeEnabled()
        ? fetchProjectKnowledge(input.claimId, `${claimText} ${input.question}`.trim(), (payload) => studioFetch(orgId, payload))
            .then((current) => projectKnowledgeState.update(() => ({ current })))
            .catch(() => {})
        : Promise.resolve(),
    ]);
    if (posed) {
      resumeCandidateState.update((cache) => ({ ...cache, usedClaimIds: [...new Set([...cache.usedClaimIds, input.claimId])] }));
    }
    if (!input.answerStatus || !planState.get()) return { status };

    // The question was already spoken as this call started. If the plan wanted a follow-up, what the
    // learner heard wins (once the claim is really posed), so the plan doesn't stay on the old project.
    let state = planState.get()!;
    let nextAction = summarizeSessionPlan(state).nextAction as { kind: string; questionType?: string };
    const mismatch = nextAction.kind !== "pose_main_question";
    const corrected = mismatch && posed ? moveToNextMainQuestion(state) : { state, moved: false };
    if (corrected.moved) {
      state = corrected.state;
      planState.update(() => state);
      nextAction = summarizeSessionPlan(state).nextAction as { kind: string; questionType?: string };
    }
    return {
      status,
      nextAction,
      ...(alreadyRecorded ? { alreadyRecordedThisTurn: true } : {}),
      ...(mismatch ? { planMismatch: true, planCorrected: corrected.moved } : {}),
    };
  },
});

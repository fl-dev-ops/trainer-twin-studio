import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  advanceSessionPlan,
  compileSessionPlan,
  recordAnswerOnce,
  summarizeSessionPlan,
} from "../lib/session-plan";
import { ensureStyleCache } from "../lib/ensure-style";
import { planState, resumeCandidateState } from "../lib/plan-state";
import { resumeClaimCandidates } from "../lib/resume-candidates";
import { studioFetch } from "../lib/studio";
import { scenarioPlaybook, twinSessionPlaybooks } from "../lib/brain";
import { roleplayGuard } from "../lib/roleplay";

/** Returned instead of a plan for scenario-ingest scenarios (run from their playbook) and twins (open conversation). */
export const PLAYBOOK_SESSION_NOTE = {
  playbookSession: true,
  note: "This session has no interview plan: it follows a playbook, or is an open conversation with the trainer's twin. Do not call session_plan again; carry on with the conversation.",
};

const evidenceStatus = z.enum(["untested", "partial", "sufficient", "weak", "unresolved"]);
const inputSchema = z.object({
  action: z.enum([
    "record_answer",
    "start_closing",
    "learner_question_during_closing",
    "confirm_end",
  ]).optional(),
  answerStatus: z.enum(["strong", "partial", "vague", "contradictory", "unknown"]).optional()
    .describe("Grade strictly: strong requires a complete, correct mechanism with no material contradiction; fluency or keywords alone are not strong."),
  evidenceUpdates: z.record(z.string(), evidenceStatus).optional()
    .describe("Only mark evidence sufficient when answerStatus is strong and the answer directly demonstrates that evidence."),
  reply: z.string().trim().min(1).max(600).optional()
    .describe("Voice only, per CURRENT PLAN STATE: the exact words to say to the learner this turn. Spoken immediately; say nothing else this turn. Omit when calling start_resume_question in the same response."),
});

async function initialize(ctx: any): Promise<ReturnType<typeof compileSessionPlan> | null> {
  const orgId = ctx.session?.auth?.initiator?.principalId ?? ctx.session?.auth?.current?.principalId;
  const attributes = (ctx.session?.auth?.current?.attributes ?? {}) as Record<string, string | undefined>;
  if (!orgId) throw new Error("No TrainerTwin organization is attached to this conversation");

  try {
    const result = await studioFetch<any>(orgId, {
      action: "getSessionContext",
      sessionId: attributes.sessionId,
      agentSlug: attributes.agentSlug,
    });
    // A playbook scenario would compile into quota-bound rounds that fight its own step logic.
    // Playbook sessions and twin sessions (all-skills twin or a single twin skill) have no agenda.
    if (scenarioPlaybook(result.agent?.kind, result.agent?.data ?? {}) || twinSessionPlaybooks(result.agent, undefined)) return null;
    const state = compileSessionPlan(result.agent?.data ?? {});
    planState.update(() => state);
    return state;
  } catch {
    const fallback = compileSessionPlan({});
    planState.update(() => fallback);
    return fallback;
  }
}

export default defineTool({
  description: `Execute the interview TODO plan compiled from the published session spec.

Call with no action to initialize or inspect the plan. On init the first question is auto-activated.

After each substantive learner answer, call record_answer with:
- answerStatus: strong, partial, vague, contradictory, or unknown.
- evidenceUpdates: only evidence keys supported by that answer.

Grade per the rubric in the Session Plan instructions. Only a strong answer may mark evidence sufficient.

The returned nextAction is binding:
- pose_main_question: ask the specified questionType as a new main question.
- ask_follow_up: ask one targeted follow-up for missing evidence; this is adaptive and quota-bounded.
- start_closing: call start_closing, give concise feedback, and request end confirmation.
- await_confirmation: do not ask interview questions. If the learner asks a question, answer it and call learner_question_during_closing.
- finish_session: call finish_session with no speech.

For a resume pose_main_question, the result includes resumeClaimCandidates (eligible claims with text). Pick one and call start_resume_question directly; use list_resume_claims/get_resume_claim only if none is returned or none fits.

Never substitute a different question type, exceed a follow-up allowance, or ask an interview question after closing starts.`,
  inputSchema,
  async execute(input, ctx) {
    const disabled = await roleplayGuard(ctx);
    if (disabled) return disabled;
    const current = planState.get() ?? await initialize(ctx);
    if (!current) return PLAYBOOK_SESSION_NOTE;
    let state = current;

    if (input.action === "record_answer") {
      if (!input.answerStatus) throw new Error("record_answer requires answerStatus");
      // With a reply the trainer is already speaking (bridge), so the style lookup is free here.
      if (input.reply) await ensureStyleCache(ctx).catch(() => {});
      const recorded = recordAnswerOnce(state, { answerStatus: input.answerStatus, evidenceUpdates: input.evidenceUpdates }, ctx.session?.turn?.id);
      if (recorded.alreadyRecorded) {
        return {
          ...summarizeSessionPlan(state),
          alreadyRecordedThisTurn: true,
          note: "This answer was already recorded this turn and the plan did not change. Follow nextAction above; do not call record_answer again until the learner answers again.",
        };
      }
      state = recorded.state;
      // One-call closing: the reply (feedback + "ready to end?") is already being spoken, so start
      // the closing here instead of waiting for a separate start_closing call.
      if (input.reply && (summarizeSessionPlan(state).nextAction as { kind: string }).kind === "start_closing") {
        state = advanceSessionPlan(structuredClone(state), { type: "start_closing" }).state;
      }
      planState.update(() => state);
    } else if (input.action) {
      state = advanceSessionPlan(structuredClone(state), { type: input.action }).state;
      planState.update(() => state);
    }

    const summary = summarizeSessionPlan(state);
    const isResumeInterview = state.rounds.some((round) => round.questions.some((question) => question.type === "resume"));
    if (!isResumeInterview || state.closingState !== "interviewing") return summary;

    // Hand over eligible claims (no list/get LLM round trips) and cache them so next turn's plan block
    // can offer them for a one-call new main question.
    const orgId = ctx.session?.auth?.initiator?.principalId ?? ctx.session?.auth?.current?.principalId;
    const sessionId = String(ctx.session?.auth?.current?.attributes?.sessionId ?? "");
    if (!orgId || !sessionId) return summary;
    const candidates = await resumeClaimCandidates(sessionId, (payload) => studioFetch(orgId, payload)).catch(() => []);
    resumeCandidateState.update((cache) => ({ ...cache, candidates }));
    const next = summary.nextAction as { kind: string; questionType?: string };
    const posesResumeQuestion = next.kind === "pose_main_question" && next.questionType === "resume";
    return posesResumeQuestion && candidates.length ? { ...summary, resumeClaimCandidates: candidates } : summary;
  },
});

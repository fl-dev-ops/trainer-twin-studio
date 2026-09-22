import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  advanceSessionPlan,
  compileSessionPlan,
  summarizeSessionPlan,
  type SessionPlanState,
} from "../lib/session-plan";
import { studioFetch } from "../lib/studio";

const planState = defineState<SessionPlanState | null>("trainertwin.session_plan", () => null);

const evidenceStatus = z.enum(["untested", "partial", "sufficient", "weak", "unresolved"]);
const inputSchema = z.object({
  action: z.enum([
    "prepare_next",
    "record_answer",
    "start_closing",
    "learner_question_during_closing",
    "confirm_end",
  ]).optional(),
  answerStatus: z.enum(["strong", "partial", "vague", "contradictory", "unknown"]).optional()
    .describe("Grade strictly: strong requires a complete, correct mechanism with no material contradiction; fluency or keywords alone are not strong."),
  evidenceUpdates: z.record(z.string(), evidenceStatus).optional()
    .describe("Only mark evidence sufficient when answerStatus is strong and the answer directly demonstrates that evidence."),
});

async function initialize(ctx: any) {
  const orgId = ctx.session?.auth?.initiator?.principalId ?? ctx.session?.auth?.current?.principalId;
  const attributes = (ctx.session?.auth?.current?.attributes ?? {}) as Record<string, string | undefined>;
  if (!orgId) throw new Error("No TrainerTwin organization is attached to this conversation");

  const result = await studioFetch<any>(orgId, {
    action: "getSessionContext",
    sessionId: attributes.sessionId,
    agentSlug: attributes.agentSlug,
  });
  const state = compileSessionPlan(result.agent?.data ?? {});
  planState.update(() => state);
  return state;
}

export default defineTool({
  description: `Execute the interview TODO plan compiled from the published session spec.

Call with no action to initialize or inspect the plan.

After each substantive learner answer, call record_answer with:
- answerStatus: strong, partial, vague, contradictory, or unknown.
- evidenceUpdates: only evidence keys supported by that answer.

Grade strictly:
- strong: directly answers the focal question with a correct mechanism, required reasoning/trade-off, and no material contradiction.
- partial: directionally correct but missing a mechanism, constraint, consequence, justification, or required part.
- vague: mostly generalities, keywords, repetition, or an answer too unclear to verify.
- contradictory: materially conflicts with the question, visible work, authoritative tool result, or itself.
- unknown: no substantive attempt or insufficient information to assess.
Fluency, confidence, length, and buzzwords are not evidence. If any material uncertainty remains, do not use strong. Only a strong answer may mark evidence sufficient.

The returned nextAction is binding:
- prepare_next: call prepare_next to activate the specified typed main question.
- pose_main_question: ask the specified questionType as a new main question.
- ask_follow_up: ask one targeted follow-up for missing evidence; this is adaptive and quota-bounded.
- start_closing: call start_closing, give concise feedback, and request end confirmation.
- await_confirmation: do not ask interview questions. If the learner asks a question, answer it and call learner_question_during_closing.
- finish_session: call finish_session with no speech.

Never substitute a different question type, exceed a follow-up allowance, or ask an interview question after closing starts.`,
  inputSchema,
  async execute(input, ctx) {
    let state = planState.get() ?? await initialize(ctx);

    if (input.action) {
      if (input.action === "record_answer" && !input.answerStatus) {
        throw new Error("record_answer requires answerStatus");
      }
      const result = advanceSessionPlan(structuredClone(state), input.action === "record_answer"
        ? {
            type: "record_answer",
            answerStatus: input.answerStatus!,
            evidenceUpdates: input.evidenceUpdates,
          }
        : { type: input.action });
      state = result.state;
      planState.update(() => state);
    }

    return summarizeSessionPlan(state);
  },
});

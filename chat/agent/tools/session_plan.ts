import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  applyCodeAssessment,
  advanceSessionPlan,
  classifyAnswerAssessment,
  compileSessionPlan,
  requiresKnowledgeGrounding,
  summarizeSessionPlan,
  type SessionPlanState,
} from "../lib/session-plan";
import { activeMcqState, gradeMcqSelection } from "../lib/mcq-state";
import { hasRelevantKnowledgeGrounding } from "../lib/knowledge-grounding-state";
import { planState } from "../lib/session-plan-state";
import { studioFetch } from "../lib/studio";
import { executeNamedWorkspaceTool } from "../lib/workspace-tools";

type ResumeProject = { id: string; section: string; kind: string; text: string; anchor: string };
type ResumePlanState = {
  documentId: string;
  projects: ResumeProject[];
  projectByQuestionId: Record<string, ResumeProject>;
};
const resumePlanState = defineState<ResumePlanState | null>("trainertwin.resume_plan", () => null);
const incompleteCodeRevision = defineState<Record<string, number>>(
  "trainertwin.incomplete_code_revision",
  () => ({}),
);

const evidenceStatus = z.enum(["untested", "partial", "sufficient", "weak", "unresolved"]);
const answerAssessment = z.object({
  substantive: z.boolean().describe("True only when the learner made an assessable attempt rather than refusing, deferring, or giving no answer."),
  direct: z.boolean().describe("True only when the response directly answers the focal question rather than changing the subject or offering adjacent information."),
  specific: z.boolean().describe("True only when the response contains concrete, verifiable detail rather than generic advice, textbook wording, buzzwords, or a restatement."),
  mechanismOrEvidence: z.boolean().describe("True only when the response supplies the mechanism, rationale, first-hand evidence, or concrete example required by the focal question."),
  complete: z.boolean().describe("True only when every requested part, constraint, consequence, justification, or trade-off is covered."),
  contradiction: z.boolean().describe("True when the response materially conflicts with the question, visible work, authoritative evidence, or an earlier answer."),
});
const inputSchema = z.object({
  action: z.enum([
    "record_answer",
    "start_closing",
    "learner_question_during_closing",
    "confirm_end",
  ]).optional(),
  assessment: answerAssessment.optional()
    .describe("Required for non-MCQ answers. Report observable answer qualities; the tool derives the answer status."),
  codeStatus: z.enum(["complete", "incomplete"]).optional()
    .describe("Required for coding and machine-coding answers. Complete means the submitted code implements the requested behavior; an explanation alone cannot make incomplete code complete."),
  evidenceUpdates: z.record(z.string(), evidenceStatus).optional()
    .describe("Only mark evidence sufficient when the structured assessment supports a strong answer and directly demonstrates that evidence."),
});

async function initialize(ctx: any) {
  const orgId = ctx.session?.auth?.initiator?.principalId ?? ctx.session?.auth?.current?.principalId;
  const attributes = (ctx.session?.auth?.current?.attributes ?? {}) as Record<string, string | undefined>;
  if (!orgId) throw new Error("No TrainerTwin organization is attached to this conversation");

  try {
    const result = await studioFetch<any>(orgId, {
      action: "getSessionContext",
      sessionId: attributes.sessionId,
      agentSlug: attributes.agentSlug,
    });
    const state = compileSessionPlan(result.agent?.data ?? {});
    planState.update(() => state);
    const claims = (result.resume?.claims ?? []) as ResumeProject[];
    const projectClaims = claims.filter((claim) => claim.kind === "project");
    const projects = [
      ...projectClaims,
      ...claims.filter((claim) => claim.kind !== "project"),
    ];
    resumePlanState.update(() => result.resume?.documentId && projects.length
      ? { documentId: result.resume.documentId, projects, projectByQuestionId: {} }
      : null);
    return state;
  } catch {
    const fallback = compileSessionPlan({});
    planState.update(() => fallback);
    resumePlanState.update(() => null);
    return fallback;
  }
}

async function highlightResumeProject(ctx: any, questionId: string) {
  const resume = resumePlanState.get();
  if (!resume) return null;
  const existing = resume.projectByQuestionId[questionId];
  if (existing) return existing;

  const used = new Set(Object.values(resume.projectByQuestionId).map(({ id }) => id));
  const project = resume.projects.find(({ id }) => !used.has(id));
  if (!project) return null;

  const orgId = ctx.session?.auth?.initiator?.principalId ?? ctx.session?.auth?.current?.principalId;
  const sessionId = String(ctx.session?.auth?.current?.attributes?.sessionId ?? "");
  if (!orgId || !sessionId) throw new Error("No session attached to this conversation");
  const response = await studioFetch<{ status: string }>(orgId, {
    action: "enqueueWorkspaceCommand",
    sessionId,
    callId: `${ctx.callId}-highlight`,
    tool: "surface",
    input: {
      action: "highlight_document",
      payload: { fileId: resume.documentId, query: project.anchor || project.text },
    },
  });
  if (response.status !== "completed") throw new Error("Resume highlight did not complete");
  resumePlanState.update((current) => current ? {
    ...current,
    projectByQuestionId: { ...current.projectByQuestionId, [questionId]: project },
  } : current);
  return project;
}

export default defineTool({
  description: `Execute the interview TODO plan compiled from the published session spec.

Call with no action to initialize or inspect the plan. On init the first question is auto-activated.

After each learner response to an active interview question, call record_answer with:
- assessment: substantive, direct, specific, mechanismOrEvidence, complete, and contradiction. The tool derives the answer status; you do not choose it.
- codeStatus for coding and machine-coding: complete only when the currently submitted code implements the requested behavior; otherwise incomplete.
- evidenceUpdates: only evidence keys supported by that answer.

For a technical answer that may be strong, partial, or contradictory, call search_knowledge first. A relevant result from the current turn is required before this tool will advance the plan.

Grade per the rubric in the Session Plan instructions. Only a strong answer may mark evidence sufficient.

The returned nextAction and requiredBeforeSpeech are binding. A resume main-question result may confirm that its project highlight already completed; do not repeat that surface call:
- pose_main_question: ask the specified questionType as a new main question.
- ask_follow_up: ask one targeted follow-up for missing evidence; this is adaptive and quota-bounded.
- start_closing: the plan enters closing automatically when the final configured question completes; request end confirmation.
- await_confirmation: do not ask interview questions. If the learner asks a question, answer it and call learner_question_during_closing.
- finish_session: confirm_end finalizes the session directly; emit no speech.

Never substitute a different question type, exceed a follow-up allowance, or ask an interview question after closing starts.`,
  inputSchema,
  async execute(input, ctx) {
    let state = planState.get() ?? await initialize(ctx);
    let closingStarted = false;
    let closingQuestionAnswered = false;
    let sessionEnded = false;
    let knowledgeRequiredBeforeSpeech = false;

    if (input.action) {
      const activeQuestion = summarizeSessionPlan(state).activeQuestion;
      let answerStatus = input.assessment ? classifyAnswerAssessment(input.assessment) : undefined;
      if (input.action === "record_answer" && activeQuestion?.type !== "mcq" && !input.assessment) {
        throw new Error("record_answer requires assessment for non-MCQ answers");
      }
      if (
        input.action === "record_answer"
        && activeQuestion?.type === "mcq"
      ) {
        const response: any = await executeNamedWorkspaceTool("get_choice_state", {}, ctx);
        const choice = response?.result?.result;
        const isCorrect = gradeMcqSelection(activeMcqState.get(), choice?.questionId, choice?.selectedId);
        if (isCorrect === null) {
          return {
            ...summarizeSessionPlan(state),
            blockedReason: "mcq_selection_required",
            requiredBeforeSpeech: "Ask the learner to select and submit an option. Do not advance or ask another question.",
            closingStarted,
            closingQuestionAnswered,
            sessionEnded,
          };
        }
        answerStatus = isCorrect ? "strong" : "partial";
      }
      if (
        input.action === "record_answer"
        && (activeQuestion?.type === "coding" || activeQuestion?.type === "machine-coding")
      ) {
        if (!input.codeStatus) {
          throw new Error("record_answer requires codeStatus for a coding question");
        }
        const response: any = await executeNamedWorkspaceTool("get_code_state", {}, ctx);
        const codeState = response?.result?.result;
        if (codeState?.submitted !== true || !Number.isInteger(codeState?.submissionRevision)) {
          return {
            ...summarizeSessionPlan(state),
            blockedReason: "code_submission_required",
            requiredBeforeSpeech: "Ask the learner to submit the current code in the editor. Do not advance or ask another question.",
            closingStarted,
            closingQuestionAnswered,
            sessionEnded,
          };
        }
        const codeAssessment = applyCodeAssessment(
          answerStatus!,
          input.codeStatus,
          codeState.submissionRevision,
          incompleteCodeRevision.get()[activeQuestion.id],
        );
        answerStatus = codeAssessment.answerStatus;
        if (codeAssessment.incompleteRevision !== null) {
          incompleteCodeRevision.update((current) => ({
            ...current,
            [activeQuestion.id]: codeAssessment.incompleteRevision!,
          }));
        } else {
          incompleteCodeRevision.update((current) => {
            const next = { ...current };
            delete next[activeQuestion.id];
            return next;
          });
        }
      }
      knowledgeRequiredBeforeSpeech = input.action === "record_answer"
        && Boolean(activeQuestion && requiresKnowledgeGrounding(activeQuestion.type, answerStatus!));
      if (knowledgeRequiredBeforeSpeech && !hasRelevantKnowledgeGrounding(ctx.session.turn.id)) {
        return {
          ...summarizeSessionPlan(state),
          blockedReason: "knowledge_grounding_required",
          requiredBeforeSpeech: "Call search_knowledge for the active technical concept, then retry session_plan. Do not make a technical judgment before a relevant result.",
          knowledgeRequiredBeforeSpeech,
          closingStarted,
          closingQuestionAnswered,
          sessionEnded,
        };
      }
      let result = advanceSessionPlan(structuredClone(state), input.action === "record_answer"
        ? {
            type: "record_answer",
            answerStatus: answerStatus!,
            evidenceUpdates: input.evidenceUpdates,
            turnId: ctx.session.turn.id,
          }
        : { type: input.action });
      if (input.action === "record_answer" && result.nextAction.kind === "start_closing") {
        result = advanceSessionPlan(result.state, { type: "start_closing" });
        closingStarted = true;
      } else if (input.action === "start_closing") {
        closingStarted = true;
      } else if (input.action === "learner_question_during_closing") {
        closingQuestionAnswered = true;
      }
      state = result.state;
      if (closingStarted) {
        await executeNamedWorkspaceTool("surface", { action: "close_surface" }, {
          ...ctx,
          callId: `${ctx.callId}-close-surface`,
        });
      }
      planState.update(() => state);
      if (input.action === "confirm_end") {
        await executeNamedWorkspaceTool("finish_session", {}, ctx);
        sessionEnded = true;
      }
    }

    const summary = {
      ...summarizeSessionPlan(state),
      closingStarted,
      closingQuestionAnswered,
      sessionEnded,
      knowledgeRequiredBeforeSpeech,
    };
    if (
      summary.nextAction.kind === "pose_main_question" &&
      summary.nextAction.questionType === "resume"
    ) {
      const project = await highlightResumeProject(ctx, summary.nextAction.questionId);
      return {
        ...summary,
        highlightedResumeProject: project
          ? { claimId: project.id, section: project.section, text: project.text }
          : null,
        requiredBeforeSpeech: project
          ? "The resume project is already highlighted. Ask one question about exactly this highlighted project; do not call surface again."
          : "No unused resume claim was available. Ask the learner to choose a project without naming one.",
      };
    }
    if (summary.nextAction.kind === "ask_follow_up" && summary.nextAction.questionType === "resume") {
      const project = resumePlanState.get()?.projectByQuestionId[summary.nextAction.questionId] ?? null;
      return {
        ...summary,
        highlightedResumeProject: project
          ? { claimId: project.id, section: project.section, text: project.text }
          : null,
        requiredBeforeSpeech: "Keep the follow-up on the currently highlighted resume project. Do not call surface again.",
      };
    }
    return summary;
  },
});

import { z } from "zod";
import { defineTool } from "eve/tools";
import { activeMcqState, prepareMcqPayload } from "../lib/mcq-state";
import { assertActivePlanQuestion, type QuestionType } from "../lib/session-plan";
import { planState } from "../lib/session-plan-state";
import { executeWorkspaceTool } from "../lib/workspace-tools";

const plannedSurfaceTypes: Partial<Record<string, readonly QuestionType[]>> = {
  open_choice: ["mcq"],
  open_code_editor: ["coding", "code-output", "machine-coding"],
  open_whiteboard: ["system-design"],
};

export const inputSchema = z.object({
  action: z.string().trim().min(1).max(60),
  payload: z.record(z.string(), z.unknown()).optional(),
}).superRefine((input, ctx) => {
  if (
    plannedSurfaceTypes[input.action]
    && (typeof input.payload?.questionId !== "string" || !input.payload.questionId.trim())
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["payload", "questionId"],
      message: `${input.action} requires the active session-plan questionId`,
    });
  }
  if (
    (input.action === "open_pdf" || input.action === "highlight_document")
    && (typeof input.payload?.fileId !== "string" || !input.payload.fileId.trim())
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["payload", "fileId"],
      message: `${input.action} requires a non-empty SESSION DATA fileId`,
    });
  }
});

export default defineTool({
  description: 'Open or change the learner-visible workspace. MUST call when: (1) [OPENING] with an attached PDF → open_pdf, (2) posing a system-design question → open_whiteboard, (3) posing a coding/code-output/machine-coding question → open_code_editor, (4) posing an mcq question → open_choice, (5) naming a specific resume claim that session_plan has not already highlighted → highlight_document before speaking, (6) learner requests a surface. Resume main questions returned by session_plan already include a completed project highlight; do not call surface again for those questions or their follow-ups. Valid actions: open_pdf, highlight_document, open_whiteboard, open_code_editor, open_choice, open_image, open_presentation, close_surface. For open_code_editor pass payload { questionId, question, language, starterCode, readOnly } (starterCode: "" for blank editor; readOnly: true for code-output). Call for every newly posed main question with a unique questionId even if the editor is already open; never call on follow-up questions. For open_choice pass payload { questionId, question, options: [{ id, text }], correctOptionId, code? }; correctOptionId is retained privately and never sent to the learner. For documents, pass a SESSION DATA fileId in payload; never invent IDs. For highlight_document pass payload { fileId, query } where query is exact text or a distinctive phrase from the resume.',
  inputSchema,
  async execute(input, ctx) {
    const payload = input.payload ?? {};
    const questionId = typeof payload.questionId === "string" ? payload.questionId : null;
    const allowedTypes = plannedSurfaceTypes[input.action];
    if (allowedTypes) {
      // inputSchema guarantees a non-empty ID for planned question surfaces.
      assertActivePlanQuestion(planState.get(), questionId!, allowedTypes);
    }
    if (input.action === "open_choice") {
      const { active, publicPayload } = prepareMcqPayload(payload);
      activeMcqState.update(() => active);
      return executeWorkspaceTool({ ...input, payload: publicPayload }, ctx);
    }

    activeMcqState.update(() => null);
    return executeWorkspaceTool(input, ctx);
  },
});

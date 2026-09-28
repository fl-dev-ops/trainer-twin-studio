import { z } from "zod";
import { defineTool } from "eve/tools";
import { activeMcqState, prepareMcqPayload } from "../lib/mcq-state";
import { executeWorkspaceTool } from "../lib/workspace-tools";

const inputSchema = z.object({
  action: z.string().trim().min(1).max(60),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export default defineTool({
  description: 'Open or change the learner-visible workspace. Use open_pdf for an attached PDF. Resume interviews must use start_resume_question with a claim ID for highlights, never highlight_document or a free-form query. For other documents, highlight_document may search for a phrase. Also supports open_whiteboard, open_code_editor, open_choice, open_image, open_presentation, close_surface. For open_code_editor pass payload { questionId, question, language, starterCode, readOnly }. For open_choice pass payload { questionId, question, options: [{ id, text }], correctOptionId, code? }. For documents, pass a SESSION DATA fileId; never invent IDs.',
  inputSchema,
  async execute(input, ctx) {
    const payload = input.payload ?? {};
    if (input.action === "open_choice") {
      const { active, publicPayload } = prepareMcqPayload(payload);
      activeMcqState.update(() => active);
      return executeWorkspaceTool({ ...input, payload: publicPayload }, ctx);
    }

    activeMcqState.update(() => null);
    return executeWorkspaceTool(input, ctx);
  },
});

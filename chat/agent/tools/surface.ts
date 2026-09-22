import { z } from "zod";
import { defineTool } from "eve/tools";
import { activeMcqState, prepareMcqPayload } from "../lib/mcq-state";
import { executeWorkspaceTool } from "../lib/workspace-tools";

const inputSchema = z.object({
  action: z.string().trim().min(1).max(60),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export default defineTool({
  description: 'Open or change the learner-visible workspace. MUST call when: (1) [OPENING] with an attached PDF → open_pdf, (2) posing a system-design question → open_whiteboard, (3) posing a coding/code-output/machine-coding question → open_code_editor, (4) posing an mcq question → open_choice, (5) referencing a specific resume section → highlight_document, (6) learner requests a surface. Valid actions: open_pdf, highlight_document, open_whiteboard, open_code_editor, open_choice, open_image, open_presentation, close_surface. For open_code_editor pass payload { questionId, question, language, starterCode, readOnly } (starterCode: "" for blank editor; readOnly: true for code-output). Call for every newly posed main question with a unique questionId even if the editor is already open; never call on follow-up questions. For open_choice pass payload { questionId, question, options: [{ id, text }], correctOptionId, code? }; correctOptionId is retained privately and never sent to the learner. For documents, pass a SESSION DATA fileId in payload; never invent IDs.',
  inputSchema,
  async execute(input, ctx) {
    const payload = input.payload ?? {};
    if (input.action === "open_choice") {
      const { active, publicPayload } = prepareMcqPayload(payload);
      activeMcqState.update(() => active);
      return executeWorkspaceTool({ ...input, payload: publicPayload }, ctx);
    }

    if (["open_code_editor", "open_whiteboard", "open_pdf", "open_image", "open_presentation", "close_surface"].includes(input.action)) {
      activeMcqState.update(() => null);
    }
    return executeWorkspaceTool(input, ctx);
  },
});

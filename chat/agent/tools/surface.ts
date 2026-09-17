import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  'Open or change the learner-visible workspace when an attached artifact should be shown, the active task needs a shared surface, or the learner requests it. Valid actions: open_pdf, highlight_document, open_whiteboard, open_code_editor, open_image, open_presentation, close_surface. For documents, pass a SESSION DATA fileId in payload; never invent IDs. On [OPENING] with an attached PDF, call open_pdf. Do not call for ordinary verbal discussion with no artifact.',
  z.object({ action: z.string().trim().min(1).max(60), payload: z.record(z.string(), z.unknown()).optional() }),
);

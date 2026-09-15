import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  'Change the learner-visible workspace only when the active task needs it or the learner explicitly requests it. Valid actions: open_pdf, highlight_document, open_whiteboard, open_code_editor, open_image, open_presentation, close_surface. For documents, pass a SESSION DATA fileId in payload; never invent IDs. Do not call for ordinary verbal discussion or merely because an artifact exists.',
  z.object({ action: z.string().trim().min(1).max(60), payload: z.record(z.string(), z.unknown()).optional() }),
);

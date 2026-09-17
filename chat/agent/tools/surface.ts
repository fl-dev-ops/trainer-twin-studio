import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  'Open or change the learner-visible workspace. MUST call when: (1) [OPENING] with an attached PDF → open_pdf, (2) posing a system-design question → open_whiteboard, (3) posing a coding/code-output/machine-coding question → open_code_editor, (4) referencing a specific resume section → highlight_document, (5) learner requests a surface. Valid actions: open_pdf, highlight_document, open_whiteboard, open_code_editor, open_image, open_presentation, close_surface. For documents, pass a SESSION DATA fileId in payload; never invent IDs.',
  z.object({ action: z.string().trim().min(1).max(60), payload: z.record(z.string(), z.unknown()).optional() }),
);

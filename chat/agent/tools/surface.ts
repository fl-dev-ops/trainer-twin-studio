import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  'Open or close an interview workspace surface (e.g., code editor, whiteboard, pdf, presentation).',
  z.object({ action: z.string().trim().min(1).max(60), payload: z.record(z.string(), z.unknown()).optional() }),
);

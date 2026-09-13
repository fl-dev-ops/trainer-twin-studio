import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  'Navigate to a specific slide in the presentation (0-indexed).',
  z.object({ slide_index: z.number().int().min(0) }),
);

import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  "Highlight one option on the open MCQ by id (A, B, C, …) without changing the learner's selection. MUST call when discussing a specific option.",
  z.object({ option_id: z.string().trim().min(1).max(40) }),
);

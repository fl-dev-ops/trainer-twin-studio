import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  "Required before replying when a candidate is unsure, stuck, does not know, or requests help about an active Coding, Machine coding, or Code output editor, or after an incorrect or unexplained code-output run. Read inclusive one-based lines 1 through 200 and never read the returned code aloud.",
  z.object({ from_line: z.number().int().min(1), to_line: z.number().int().min(1) }),
);

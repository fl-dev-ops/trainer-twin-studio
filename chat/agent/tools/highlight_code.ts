import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  "Use after read_code_range. Highlight the smallest relevant inclusive one-based whole-line range without changing the code, then ask one targeted question that leads the candidate to calculate the exact output or next implementation step.",
  z.object({ from_line: z.number().int().min(1), to_line: z.number().int().min(1) }),
);

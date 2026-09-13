import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  'Highlight a line range in the candidate code editor without changing code.',
  z.object({ from_line: z.number().int().min(1), to_line: z.number().int().min(1) }),
);

import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  'Read lines from the active code editor. Provide 1-based from_line and to_line.',
  z.object({ from_line: z.number().int().min(1), to_line: z.number().int().min(1) }),
);

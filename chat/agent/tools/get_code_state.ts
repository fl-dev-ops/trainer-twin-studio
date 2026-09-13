import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  'Get the full code, active programming language, and cursor selection in the editor.',
  z.object({}),
);

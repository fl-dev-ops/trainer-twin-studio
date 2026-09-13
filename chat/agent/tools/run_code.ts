import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  'Execute the current code in the candidate editor and retrieve execution output.',
  z.object({}),
);

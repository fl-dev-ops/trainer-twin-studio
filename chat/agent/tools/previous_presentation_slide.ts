import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  'Return to the previous slide in the presentation.',
  z.object({}),
);

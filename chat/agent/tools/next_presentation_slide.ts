import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  'Advance to the next slide in the presentation.',
  z.object({}),
);

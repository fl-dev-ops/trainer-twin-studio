import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  'Signals the interview conclusion.',
  z.object({}),
);

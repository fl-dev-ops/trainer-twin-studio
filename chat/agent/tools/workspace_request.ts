import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  'Request an action or state from the browser workspace over RPC.',
  z.object({ method: z.string().trim().min(1).max(80), action: z.string().trim().min(1).max(80), payload: z.record(z.string(), z.unknown()).optional() }),
);

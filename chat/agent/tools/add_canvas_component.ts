import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  'Add a system architecture component box with a label to the whiteboard canvas.',
  z.object({ label: z.string().trim().min(1).max(200), x: z.number().int().default(100), y: z.number().int().default(100) }),
);

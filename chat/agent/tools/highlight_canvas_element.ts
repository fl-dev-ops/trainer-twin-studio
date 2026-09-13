import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  'Highlight and scroll to a specific component element on the whiteboard canvas by ID.',
  z.object({ element_id: z.string().trim().min(1).max(200) }),
);

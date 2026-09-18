import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  "Retrieve all elements and diagrams currently drawn on the whiteboard canvas. MUST call when the candidate says they have drawn, sketched, or updated the whiteboard ('I have drawn', 'Check my diagram', 'Here is my architecture'), or before asking follow-ups about their design.",
  z.object({}),
);

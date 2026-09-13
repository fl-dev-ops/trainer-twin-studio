import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  'Clear all elements from the whiteboard canvas.',
  z.object({}),
);

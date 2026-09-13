import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  'Retrieve all elements and diagrams currently drawn on the whiteboard canvas.',
  z.object({}),
);

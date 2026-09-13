import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  'Get current presentation slide number, total slides, and viewer state.',
  z.object({}),
);

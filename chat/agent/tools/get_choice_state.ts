import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  "Get the on-screen MCQ: question, options, the learner's current selection, and whether they have submitted. MUST call when the choice surface is open and you need to know if they picked or submitted an answer before speaking.",
  z.object({}),
);

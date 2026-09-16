import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  'Finalize the current session exactly once after the learner clearly ends it or the configured agenda is complete. Do not call for pauses, hesitation, temporary silence, or a topic transition. This is a pure side effect and its successful result requires no follow-up speech.',
  z.object({}),
);

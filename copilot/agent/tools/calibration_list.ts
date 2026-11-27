import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description:
    "List calibrations, newest first: sessions where a team member rated their twin's answers. Each has the session id, the twin, who calibrated (name), when, how many answers were rated and how many were marked off, and whether it has been scored. Filter by twin slug. 20 per page: pass nextOffset back as offset. Not the rated answers' text; session_read reads that session's transcript.",
  inputSchema: z.object({
    twin: z.string().trim().min(1).max(200).optional(),
    offset: z.number().int().nonnegative().optional(),
  }).strict(),
  async execute(input, ctx) {
    return studioResult(ctx, { action: "listCalibrations", ...input });
  },
});

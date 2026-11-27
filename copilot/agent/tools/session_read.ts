import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description:
    "Read one session by its id (from session_list): who, when, length, status, its report (summary, tags, key moments with quotes, focus for next time, score, rubric and goals for role plays), the learner's feedback, whether it was recorded, and the transcript (who spoke and what they said), 60 turns at a time: pass nextFromTurn back as fromTurn for the rest. Never: the recording itself or a link to it, files the learner uploaded, emails, codes. Read only the sessions the trainer asks about.",
  inputSchema: z.object({
    id: z.string().trim().min(1).max(100),
    fromTurn: z.number().int().min(1).optional(),
  }).strict(),
  async execute(input, ctx) {
    return studioResult(ctx, { action: "readSession", ...input });
  },
});

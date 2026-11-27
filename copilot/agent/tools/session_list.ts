import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description:
    "List this organization's sessions, newest first: twin sessions, role-play sessions and website-bot sessions. Each has its id, kind, twin or role play, the learner's name, when, length in minutes, status, whether a report is ready (with its score and tags), and the learner's rating. Filter by kind, by learner name (part of a name; never an email), by twin or role-play slug, and by the last 7, 30 (default) or 90 days. 20 per page: pass nextOffset back as offset for more. Learners are only ever named: no emails, files they uploaded, recordings, IP or website. Use session_read for one session's report and transcript.",
  inputSchema: z.object({
    kind: z.enum(["twin", "roleplay", "bot"]).optional(),
    learner: z.string().trim().min(1).max(120).optional(),
    agent: z.string().trim().min(1).max(200).optional().describe("A twin or role-play slug"),
    days: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional(),
    offset: z.number().int().nonnegative().optional(),
  }).strict(),
  async execute(input, ctx) {
    return studioResult(ctx, { action: "listSessions", ...input });
  },
});

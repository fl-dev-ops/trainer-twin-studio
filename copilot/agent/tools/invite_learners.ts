import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description:
    "Invite learners by email to a twin, twin skill or role play; each gets an email with their personal link. Twins need minutes (each learner's practice budget) and may take an end date (accessUntil, YYYY-MM-DD). Learners only: studio members (admin, team) are refused. You cannot remove learners, change their minutes or anyone's role; say so if asked.",
  inputSchema: z.object({
    slug: z.string().min(1),
    emails: z.array(z.string().email()).min(1).max(100),
    minutes: z.number().int().min(1).max(10_000).optional(),
    accessUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
  async execute(input, ctx) {
    return studioResult(ctx, { action: "inviteLearners", ...input });
  },
});

import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description:
    "Read one role play by slug (from list_roleplays): name, description, Settings (Before), Tools, version, its invited learners and, for a builder role play, its builder fields (client name, situation, difficulty, opening, goals, rubric...). Read it before proposing a change, so the change shows what it was.",
  inputSchema: z.object({ slug: z.string().min(1) }),
  async execute({ slug }, ctx) {
    return studioResult(ctx, { action: "get", slug, kind: "roleplay" });
  },
});

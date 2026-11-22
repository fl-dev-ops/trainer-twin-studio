import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description: "Read this organization's users: display name, role (admin, team, learner), whether disabled, and currently assigned twins and role plays. Optionally search by name; use nextOffset to fetch more results. No emails, invite links, credits, or session history. Cannot change roles or assignments.",
  inputSchema: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    offset: z.number().int().nonnegative().max(2_147_483_647).optional(),
  }).strict(),
  async execute(input, ctx) {
    return studioResult(ctx, { action: "listUsers", ...input });
  },
});

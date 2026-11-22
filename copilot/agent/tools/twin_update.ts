import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { describeChanges, proposedInput } from "../lib/changes";
import { studioResult } from "../lib/studio";

const inputSchema = z.object({
  slug: z.string().min(1).describe("From twin_list."),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  proposed: proposedInput,
  label: z.string().trim().min(1).max(200).optional().describe("Its current name as twin_read/roleplay_read/persona_list showed it; shown on the approval card instead of the slug."),
}).strict();

export default defineTool({
  description:
    "Rename a twin or twin skill, or change its description. Only the fields you pass change. Needs the trainer's approval; read it with twin_read first. Not for Before settings (twin_settings_update) or a skill's content (twin-creator).",
  inputSchema,
  approval: {
    request: always(),
    prompt: ({ input }) => `Change twin "${input?.label ?? input?.slug}": ${describeChanges({ name: input?.name, description: input?.description }, undefined, input?.proposed) || "no fields"}`,
  },
  async execute({ slug, name, description }, ctx) {
    return studioResult(ctx, { action: "updateTwin", slug, ...(name !== undefined ? { name } : {}), ...(description !== undefined ? { description } : {}) });
  },
});

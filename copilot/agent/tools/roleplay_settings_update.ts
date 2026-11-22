import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { describeChanges, proposedInput } from "../lib/changes";
import { beforeSettings } from "../lib/settings-schema";
import { studioResult } from "../lib/studio";

const inputSchema = z.object({
  slug: z.string().min(1).describe("From roleplay_list."),
  settings: beforeSettings.extend({ preUploadRequired: z.boolean().describe("The learner must add the file before the call.") }).partial().strict(),
  proposed: proposedInput,
  label: z.string().trim().min(1).max(200).optional().describe("Its current name as twin_read/roleplay_read/persona_list showed it; shown on the approval card instead of the slug."),
}).strict();

export default defineTool({
  description:
    "Change a role play's Settings tab (screen share, upload before the call and whether it is required, upload during the call, upload title and instruction). Only the settings you pass change. Needs the trainer's approval; read it with roleplay_read first. Not for workspace tools (roleplay_tools_update) or the script.",
  inputSchema,
  approval: {
    request: always(),
    prompt: ({ input }) => `Change role play "${input?.label ?? input?.slug}": ${describeChanges(input?.settings, undefined, input?.proposed) || "no fields"}`,
  },
  async execute({ slug, settings }, ctx) {
    return studioResult(ctx, { action: "updateRoleplay", slug, before: settings });
  },
});

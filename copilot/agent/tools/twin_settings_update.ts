import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { describeChanges, proposedInput } from "../lib/changes";
import { beforeSettings } from "../lib/settings-schema";
import { studioResult } from "../lib/studio";

const inputSchema = z.object({ slug: z.string().min(1).describe("From twin_list."), settings: beforeSettings,
  proposed: proposedInput,
  label: z.string().trim().min(1).max(200).optional().describe("Its current name as twin_read/roleplay_read/persona_list showed it; shown on the approval card instead of the slug."),
}).strict();

export default defineTool({
  description:
    "Change a twin or twin skill's Before settings (screen share, upload before or during the call, upload title and instruction). Only the settings you pass change. Needs the trainer's approval; read it with twin_read first. Not for name or description (twin_update).",
  inputSchema,
  approval: {
    request: always(),
    prompt: ({ input }) => `Change twin "${input?.label ?? input?.slug}": ${describeChanges(input?.settings, undefined, input?.proposed) || "no fields"}`,
  },
  async execute({ slug, settings }, ctx) {
    return studioResult(ctx, { action: "updateTwin", slug, settings });
  },
});

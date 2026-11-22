import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { describeChanges, proposedInput } from "../lib/changes";
import { studioResult } from "../lib/studio";

const inputSchema = z.object({
  slug: z.string().min(1).describe("A roleplay-builder slug from roleplay_list."),
  builder: z.record(z.string(), z.unknown()).describe(
    "The fields to change, named as roleplay_read returns them (name, clientName, situation {scenario, hiddenTruth, learnerRole, agreesWhen, declinesWhen}, difficulty, howTheyTalk, guardedIf, opensUpIf, whatToExpect, opening, exampleLines, learnerGoals, rubric). Omitted fields keep their value.",
  ),
  proposed: proposedInput,
  label: z.string().trim().min(1).max(200).optional().describe("Its current name as twin_read/roleplay_read/persona_list showed it; shown on the approval card instead of the slug."),
}).strict();

export default defineTool({
  description:
    "Change the script fields of a builder role play (kind roleplay-builder) only. Needs the trainer's approval; read it with roleplay_read first. A brief role play is changed with roleplay_draft + roleplay_publish, a recordings one by rebuilding (roleplay_recording_load). Not for Settings (roleplay_settings_update) or Tools (roleplay_tools_update).",
  inputSchema,
  approval: {
    request: always(),
    prompt: ({ input }) => `Change role play "${input?.label ?? input?.slug}": ${describeChanges(input?.builder, undefined, input?.proposed) || "no fields"}`,
  },
  async execute({ slug, builder }, ctx) {
    return studioResult(ctx, { action: "updateRoleplay", slug, builder });
  },
});

import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { studioResult } from "../lib/studio";

const inputSchema = z.object({
  slug: z.string().min(1).describe("From roleplay_list."),
  persona: z.string().min(1).describe("A persona that plays this role play (roleplay_read lists them)."),
  character: z.string().max(20000)
    .describe("Markdown written to \"you\": who this persona is on THIS role play only (facts, what they want, what they hide, opening line, how they talk, open up, push back and end). \"\" clears it."),
  label: z.string().trim().min(1).max(200).optional().describe("The role play's current name, shown on the approval card."),
}).strict();

export default defineTool({
  description:
    "Write one persona's character for one role play: how that persona plays this role play only. No other role play ever sees it, and editing it never changes the persona. Once any persona of a role play has a character, only personas with one are picked for sessions. Needs the trainer's approval.",
  inputSchema,
  approval: {
    request: always(),
    prompt: ({ input }) => `Role play "${input?.label ?? input?.slug}": ${input?.character?.trim() ? "set" : "clear"} ${input?.persona}'s character\n\n${input?.character?.slice(0, 1500) ?? ""}`,
  },
  async execute({ slug, persona, character }, ctx) {
    return studioResult(ctx, { action: "setRoleplayCharacter", slug, persona, character });
  },
});

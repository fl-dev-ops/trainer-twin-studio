import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { studioResult } from "../lib/studio";

const inputSchema = z.object({
  slug: z.string().min(1).describe("From roleplay_list."),
  extras: z.array(z.object({ slug: z.string().min(1), active: z.boolean() })).max(20)
    .describe("Personas (persona_list slugs) that can also play it, besides its main persona, each on or off. Replaces the current extras; [] leaves only the main persona."),
  label: z.string().trim().min(1).max(200).optional().describe("Its current name, shown on the approval card."),
}).strict();

export default defineTool({
  description:
    "Let more personas play a role play: each learner session picks one active persona at random (the main persona included), so learners meet different clients in the same scenario. The main persona is changed with roleplay_update, not here. Needs the trainer's approval.",
  inputSchema,
  approval: {
    request: always(),
    prompt: ({ input }) => `Role play "${input?.label ?? input?.slug}" also played by: ${input?.extras?.map((row) => `${row.slug}${row.active ? "" : " (off)"}`).join(", ") || "nobody else"}`,
  },
  async execute({ slug, extras }, ctx) {
    return studioResult(ctx, { action: "setRoleplayPersonas", slug, extras });
  },
});

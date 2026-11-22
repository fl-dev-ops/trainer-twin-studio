import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { studioResult } from "../lib/studio";

const inputSchema = z.object({
  slug: z.string().trim().min(1).max(200).describe("The persona's slug from list_personas."),
  name: z.string().trim().min(1).max(120).optional(),
  role: z.string().trim().min(1).max(60).optional(),
  about: z.string().trim().max(2000).optional().describe(
    "Their stable personality and way of talking, written to \"you\". Never one role play's situation, facts or goals.",
  ),
  voiceId: z.string().trim().min(1).max(200).optional().describe("A voice id from list_voices."),
});

export default defineTool({
  description:
    "Change a role-play persona from list_personas (name, role, about, voice). Only what you pass changes, and it applies to the next sessions of every role play using it (list_personas shows usedBy): say so before asking. Needs the trainer's approval. Never the trainer's own persona, and never deletes; those are done in Personas.",
  inputSchema,
  approval: {
    request: always(),
    prompt: ({ input }) => {
      const { slug, ...fields } = input ?? ({} as z.infer<typeof inputSchema>);
      const changes = Object.entries(fields).map(([k, v]) => `${k} → ${JSON.stringify(v).slice(0, 140)}`).join("; ");
      return `Change persona "${slug ?? ""}": ${changes || "no fields"}`;
    },
  },
  async execute(input, ctx) {
    return studioResult(ctx, { action: "updatePersona", ...input });
  },
});

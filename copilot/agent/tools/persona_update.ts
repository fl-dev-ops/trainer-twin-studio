import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { describeChanges, proposedInput } from "../lib/changes";
import { studioResult } from "../lib/studio";

const inputSchema = z.object({
  slug: z.string().trim().min(1).max(200).describe("The persona's slug from persona_list."),
  name: z.string().trim().min(1).max(120).optional(),
  role: z.string().trim().min(1).max(60).optional(),
  about: z.string().trim().max(2000).optional().describe(
    "Their stable personality and way of talking, written to \"you\". Never one role play's situation, facts or goals.",
  ),
  voiceId: z.string().trim().min(1).max(200).optional().describe("A voice id from voice_list."),
  proposed: proposedInput,
  label: z.string().trim().min(1).max(200).optional().describe("Its current name as twin_read/roleplay_read/persona_list showed it; shown on the approval card instead of the slug."),
});

export default defineTool({
  description:
    "Load the `persona` skill first if it isn't loaded yet: it holds what a persona may contain. Change a role-play persona from persona_list (name, role, about, voice). Only what you pass changes, and it applies to the next sessions of every role play using it (persona_list shows usedBy): say so before asking. Needs the trainer's approval. Never the trainer's own persona, and never deletes; those are done in Personas.",
  inputSchema,
  approval: {
    request: always(),
    prompt: ({ input }) => {
      const { slug, label, proposed, ...fields } = input ?? ({} as z.infer<typeof inputSchema>);
      return `Change persona "${label ?? slug ?? ""}": ${describeChanges(fields, undefined, proposed) || "no fields"}`;
    },
  },
  async execute(input, ctx) {
    const { label: _label, proposed: _proposed, ...fields } = input;
    return studioResult(ctx, { action: "updatePersona", ...fields });
  },
});

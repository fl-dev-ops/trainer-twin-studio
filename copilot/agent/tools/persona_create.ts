import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { proposedInput } from "../lib/changes";
import { studioResult } from "../lib/studio";

// The Personas page's form (web/lib/persona.ts personaInputSchema): the studio checks it again.
const inputSchema = z.object({
  name: z.string().trim().min(1).max(120).describe("The person's name, as the learner will hear it."),
  role: z.string().trim().min(1).max(60).describe('Who they are, in a few words ("Buyer", "Technical interviewer").'),
  about: z.string().trim().max(2000).describe(
    "Their stable personality and way of talking, written to \"you\" in a few short sentences. Never this role play's situation, facts or goals: those belong to the role play.",
  ),
  voiceId: z.string().trim().min(1).max(200).optional().describe("A voice id from voice_list: one whose gender, age and accent fit this person. Never a new voice."),
  voiceLabel: z.string().trim().min(1).max(200).optional().describe(
    'The chosen voice as voice_list shows it, name and details ("oliver: male, middle-aged, British"); shown on the approval card instead of its id.',
  ),
  proposed: proposedInput,
});

export default defineTool({
  description:
    "Load the `persona` skill first if it isn't loaded yet: it holds what a persona may contain. Create a new persona in the Persona Library (name, role, about, voice), when none from persona_list fits a role play. Check persona_list first and never create a duplicate of an existing one. Needs the trainer's approval. To change an existing one use persona_update. It can't delete personas or touch the trainer's own persona; those are done in Personas.",
  inputSchema,
  approval: {
    request: always(),
    prompt: ({ input }) => {
      const suggested = input?.proposed?.length ? ` Suggested by the copilot: ${input.proposed.join(", ")}.` : "";
      const voice = input?.voiceId ? ` with the voice ${input.voiceLabel ?? input.voiceId}` : " with no voice yet";
      return `Create the persona "${input?.name ?? ""}" (${input?.role ?? ""})${voice}?${suggested}`;
    },
  },
  async execute(input, ctx) {
    const { proposed: _proposed, voiceLabel: _voiceLabel, ...fields } = input;
    return studioResult(ctx, { action: "createPersona", ...fields });
  },
});

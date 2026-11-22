import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { studioResult } from "../lib/studio";

// The Personas page's form (web/lib/persona.ts personaInputSchema): the studio checks it again.
const inputSchema = z.object({
  name: z.string().trim().min(1).max(120).describe("The person's name, as the learner will hear it."),
  role: z.string().trim().min(1).max(60).describe('Who they are, in a few words ("Buyer", "Technical interviewer").'),
  about: z.string().trim().max(2000).describe(
    "Their stable personality and way of talking, written to \"you\" in a few short sentences. Never this role play's situation, facts or goals: those belong to the role play.",
  ),
  voiceId: z.string().trim().min(1).max(200).optional().describe("A voice id from list_voices."),
});

export default defineTool({
  description:
    "Create a new persona in the Persona Library (name, role, about, voice), when none from list_personas fits a role play. Check list_personas first and never create a duplicate of an existing one. Needs the trainer's approval. To change an existing one use update_persona. It can't delete personas or touch the trainer's own persona; those are done in Personas.",
  inputSchema,
  approval: {
    request: always(),
    prompt: ({ input }) => `Create the persona "${input?.name ?? ""}" (${input?.role ?? ""})${input?.voiceId ? "" : " with no voice yet"}?`,
  },
  async execute(input, ctx) {
    return studioResult(ctx, { action: "createPersona", ...input });
  },
});

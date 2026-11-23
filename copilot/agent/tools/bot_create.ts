import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { proposedInput } from "../lib/changes";
import { studioResult } from "../lib/studio";

const inputSchema = z.object({
  persona: z.string().min(1).describe("Persona slug from persona_list: the trainer's own or a custom one."),
  name: z.string().trim().min(1).max(120).describe("e.g. Homepage assistant."),
  objective: z.string().trim().min(1).max(2000).describe("Its purpose: what it is for and how it should help visitors."),
  proposed: proposedInput,
}).strict();

export default defineTool({
  description:
    "Create a bot: a persona, a name and a purpose. Public calls start off and no websites are set; the trainer turns them on under Bots when ready. Add supporting skills afterwards with bot_update. Needs the trainer's approval.",
  inputSchema,
  approval: {
    request: always(),
    prompt: ({ input }) => `Create bot "${input?.name}" speaking as ${input?.persona}: ${input?.objective ?? ""}${input?.proposed?.length ? ` (suggested: ${input.proposed.join(", ")})` : ""}`,
  },
  async execute({ persona, name, objective }, ctx) {
    return studioResult(ctx, { action: "createBot", persona, name, objective });
  },
});

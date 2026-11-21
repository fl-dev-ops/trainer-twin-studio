import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { roleplayBrief } from "../lib/roleplay-brief";
import { studioResult } from "../lib/studio";

export default defineTool({
  description:
    "Role play from requirements (roleplay-creator): publishes the brief as a role play played by the persona, after draft_roleplay passed and the trainer has seen it. Publishing the same brief again changes nothing; an edited brief (same id) becomes the next version and the previous one is kept. Needs the trainer's approval. Report what the studio stored, or its error, honestly.",
  inputSchema: z.object({
    persona: z.string().min(1).describe("Persona slug from list_personas."),
    brief: roleplayBrief,
  }),
  approval: {
    request: always(),
    prompt: ({ input }) => `Publish the role play "${input?.brief?.title ?? ""}" played by ${input?.persona ?? "the persona"}? An existing one becomes its next version; the previous one is kept.`,
  },
  async execute({ persona, brief }, ctx) {
    return studioResult(ctx, { action: "publishRoleplay", persona, brief });
  },
});

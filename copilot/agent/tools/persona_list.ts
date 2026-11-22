import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description:
    "List the organization's personas (read-only): slug, name, own (the trainer's own persona) or a role-play persona, role, about, voice, and how many agents use it (usedBy). Use it to pick who plays a role play, to find the trainer's own persona for twin_create, and before persona_create or persona_update.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return studioResult(ctx, { action: "listPersonas" });
  },
});

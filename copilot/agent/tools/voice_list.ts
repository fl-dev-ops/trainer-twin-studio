import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description:
    "List the voices a persona can use (read-only): id, name, and own (cloned for this organization) or shared. Call before persona_create or a voice change in persona_update; pick a voice that fits the person's role and gender only when the trainer has not named one, and say it is a proposal.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return studioResult(ctx, { action: "listVoices" });
  },
});

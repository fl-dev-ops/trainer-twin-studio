import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description:
    "The voices a new persona can use: id, name, and own (cloned for this organization) or shared. Call before create_persona; pick a voice that fits the person's role and gender only when the trainer has not named one, and say it is a proposal.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return studioResult(ctx, { action: "listVoices" });
  },
});

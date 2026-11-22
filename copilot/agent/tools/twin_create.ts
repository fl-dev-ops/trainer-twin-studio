import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description: "Create the trainer's main twin from their own persona (persona_list, own: true). Needs the trainer's approval. If it already exists, returns it unchanged. Not for twin skills (twin-creator) or changing a twin (twin_update, twin_settings_update).",
  inputSchema: z.object({ persona: z.string().trim().min(1).max(200) }).strict(),
  approval: { request: always(), prompt: ({ input }) => `Create the main twin for ${input?.persona ?? "this trainer"}?` },
  async execute(input, ctx) {
    return studioResult(ctx, { action: "createTwin", ...input });
  },
});

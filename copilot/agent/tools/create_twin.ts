import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description: "Create the main twin for an existing trainer persona from list_personas (own: true). If their twin already exists, returns it unchanged. Creating or changing a twin skill uses twin-creator instead.",
  inputSchema: z.object({ persona: z.string().trim().min(1).max(200) }).strict(),
  approval: { request: always(), prompt: ({ input }) => `Create the main twin for ${input?.persona ?? "this trainer"}?` },
  async execute(input, ctx) {
    return studioResult(ctx, { action: "createTwin", ...input });
  },
});

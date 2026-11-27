import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description:
    "Read the organization: its name, studio address (slug), website, and how many twins, role plays, personas and knowledge bases it has. No billing, API keys or settings that hold secrets.",
  inputSchema: z.object({}).strict(),
  async execute(_input, ctx) {
    return studioResult(ctx, { action: "readOrg" });
  },
});

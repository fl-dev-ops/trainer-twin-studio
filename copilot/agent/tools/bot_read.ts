import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description:
    "Read one bot: name, persona, purpose (what it is for and how it helps visitors), supporting skills with their on/off state, version, and whether public calls are on. Read it before changing it, so the approval card can show before and after.",
  inputSchema: z.object({ slug: z.string().min(1).describe("From bot_list.") }),
  async execute({ slug }, ctx) {
    return studioResult(ctx, { action: "getBot", slug });
  },
});

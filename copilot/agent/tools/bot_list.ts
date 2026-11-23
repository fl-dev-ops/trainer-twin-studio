import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description:
    "List the trainer's bots: the agents signed-out people talk to on other channels (website widget now; WhatsApp, Slack later). Each has slug, name, persona slug, version, its supporting skills (slug, name, active) and whether public calls are on. Use before reading or changing a bot, so you use its exact slug.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return studioResult(ctx, { action: "listBots" });
  },
});

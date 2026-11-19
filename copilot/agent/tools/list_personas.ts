import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description:
    "Role play from requirements (roleplay-creator): the organization's personas, the people a role play can be played by (each a voice with a personality): slug, name, role, about, voice and how many agents use it. Pick the one that fits the AI's role; never redefine its personality in the role play.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return studioResult(ctx, { action: "listPersonas" });
  },
});

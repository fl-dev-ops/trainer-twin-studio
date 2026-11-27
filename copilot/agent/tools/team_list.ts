import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description:
    "List the studio's team (admins and team members): name, role, whether disabled, and since when. No emails. For learners and their assignments use user_list. Cannot add, remove or change anyone.",
  inputSchema: z.object({}).strict(),
  async execute(_input, ctx) {
    return studioResult(ctx, { action: "listTeam" });
  },
});

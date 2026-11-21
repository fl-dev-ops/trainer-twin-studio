import { defineTool } from "eve/tools";
import { z } from "zod";
import { roleplayBrief } from "../lib/roleplay-brief";
import { studioResult } from "../lib/studio";

export default defineTool({
  description:
    "Role play from requirements (roleplay-creator): checks a role-play brief and renders it, saving nothing. Returns the rendered SKILL.md and learner brief, or the reasons to fix. Fix every reason in the next call, all at once; at most 3 drafts. Show the trainer the result before publish_roleplay.",
  inputSchema: z.object({ brief: roleplayBrief }),
  async execute({ brief }, ctx) {
    return studioResult(ctx, { action: "draftRoleplay", brief });
  },
});

import { defineTool } from "eve/tools";
import { saveTwinSkill, twinBuildInput } from "../lib/twin-skill";
import { sessionIo } from "../lib/session-io";

export default defineTool({
  description:
    "Twin skill only (twin-creator), never a role play. Save one twin skill (skill.json, the trainer's own words as items, patterns.md, SKILL.md) in one call, then run the full check. Returns the rejected items, or the check with every reason, so fix all reasons in the next call.",
  inputSchema: twinBuildInput,
  async execute(input, ctx) {
    try {
      return await saveTwinSkill(await sessionIo(ctx), input.user, input);
    } catch (e) {
      return { error: (e as Error).message };
    }
  },
});

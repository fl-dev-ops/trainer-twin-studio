import { defineTool } from "eve/tools";
import { z } from "zod";
import { pool, pushOutput } from "../lib/origin";
import { sessionIo } from "../lib/session-io";
import { publishTwinSkillToStudio, runIdFor } from "../lib/studio-publish";
import { prepareTwinPublication } from "../lib/twin-skill";

export default defineTool({
  description:
    "Twin skill only (twin-creator): publishes one twin skill to the trainer's twin. Checks it again first and sends nothing when the check fails; returns the reasons. studio reports what TrainerTwin stored; report failures honestly.",
  inputSchema: z.object({
    user: z.string(),
    skill: z.string().describe("The twin skill id."),
    persona: z.string().optional().describe("The trainer's TrainerTwin persona. Defaults to user."),
  }),
  async execute({ user, skill, persona }, ctx) {
    const { files, rejected } = await prepareTwinPublication(await sessionIo(ctx), user, skill);
    if (!files.length) return { published: 0, rejected };
    const published = await pool(files, 8, (f) => pushOutput(user, f.path, f.text));
    const principal = ctx.session.auth.current;
    const url = process.env.STUDIO_URL;
    const secret = process.env.SCENARIO_INGEST_SECRET;
    const studio = principal?.principalType !== "organization"
      ? { skipped: "This session is not attached to a TrainerTwin organization." }
      : !url || !secret
        ? { skipped: "STUDIO_URL or SCENARIO_INGEST_SECRET is not configured." }
        : await publishTwinSkillToStudio({ url, secret, orgId: principal.principalId, persona: persona ?? user, runId: runIdFor(ctx.session.id) }, skill, files, fetch, ctx.abortSignal);
    return { published: published.length, where: published[0]?.replace(/\/[^/]*$/, "") ?? null, rejected, studio };
  },
});

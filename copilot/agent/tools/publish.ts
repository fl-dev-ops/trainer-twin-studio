import { defineTool } from "eve/tools";
import { z } from "zod";
import { pool, pushOutput, staleOutputs } from "../lib/origin";
import { preparePublication } from "../lib/publication";
import { sessionIo } from "../lib/session-io";
import { publishToStudio, runIdFor } from "../lib/studio-publish";

export default defineTool({
  description: "Validate and publish a snapshot. Copies only passing scenarios (both modes and full move coverage), a filtered plan, and privacy-checked report/specs. Never copies work files or unknown outputs. Returns rejected reasons for anything withheld; report them rather than claiming it was published. stale lists older output files this run did not write (for example a scenario no longer in the plan); they are left in place, so report them as out of date. studio reports what TrainerTwin stored (each scenario's slug and version, or why it failed); report failures honestly.",
  inputSchema: z.object({
    user: z.string(),
    persona: z.string().optional().describe("TrainerTwin persona the scenarios are played by. Defaults to user."),
  }),
  async execute({ user, persona }, ctx) {
    const { files, rejected } = await preparePublication(await sessionIo(ctx), user);
    const published = await pool(files, 16, (f) => pushOutput(user, f.path, f.text));
    return {
      published: published.length,
      where: published[0]?.replace(/\/[^/]*$/, "") ?? null,
      rejected,
      stale: await staleOutputs(user, published),
      studio: await toStudio(files, user, persona, ctx),
    };
  },
});

/** Into the TrainerTwin web app, for the organization this session belongs to (set by the web proxy). */
async function toStudio(
  files: { path: string; text: string }[],
  user: string,
  persona: string | undefined,
  ctx: { abortSignal?: AbortSignal; session: { id: string; auth: { current: { principalId: string; principalType: string } | null } } },
) {
  const principal = ctx.session.auth.current;
  const url = process.env.STUDIO_URL;
  const secret = process.env.SCENARIO_INGEST_SECRET;
  if (principal?.principalType !== "organization") return { skipped: "This session is not attached to a TrainerTwin organization." };
  if (!url || !secret) return { skipped: "STUDIO_URL or SCENARIO_INGEST_SECRET is not configured." };
  if (!files.some((f) => f.path === "plan.json")) return { skipped: "Nothing passed validation, so nothing was sent." };
  return publishToStudio(
    { url, secret, orgId: principal.principalId, persona: persona ?? user, runId: runIdFor(ctx.session.id) },
    files,
    fetch,
    ctx.abortSignal,
  );
}

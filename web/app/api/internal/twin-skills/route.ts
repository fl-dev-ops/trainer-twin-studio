import { ingestAuthorized, ingestTwinSkill, ScenarioIngestError, twinSkillIngestSchema, type TwinSkillIngestInput } from "@/lib/scenario-ingest";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Stores one twin skill from the copilot's twin-creator (the trainer's knowledge, decisions and approach on one topic)
 * as a skill of the trainer's twin. Same contract as /api/internal/scenarios: Bearer secret + x-trainertwin-org-id.
 * Body: { personaSlug, skill: SKILL.md, manifest: skill.json, items: items.json, patterns?, runId? }.
 * Re-sending the same skill is a no-op; a changed one gets a new version and replaces its items.
 */
export async function POST(request: Request) {
  if (!ingestAuthorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const orgId = request.headers.get("x-trainertwin-org-id")?.trim();
  if (!orgId) return Response.json({ error: "Organization is required" }, { status: 400 });

  const body: unknown = await request.json().catch(() => null);
  const parsed = twinSkillIngestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid twin skill", issues: parsed.error.issues.slice(0, 10) }, { status: 400 });
  }
  try {
    // Validated, but stored as sent (zod output reorders unknown keys).
    const result = await ingestTwinSkill(orgId, body as TwinSkillIngestInput);
    return Response.json({ ok: true, skill: result }, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof ScenarioIngestError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[API:internal:twin-skills] ingest failed:", error);
    return Response.json({ error: "Could not store the twin skill" }, { status: 500 });
  }
}

import { copilotActor } from "@/lib/copilot-actor";
import { ingestScenario, ScenarioIngestError, scenarioIngestSchema, type ScenarioIngestInput } from "@/lib/scenario-ingest";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Stores one scenario from the scenario-ingest agent and makes it available as a role play.
 * Same contract shape as the copilot's /api/copilot/studio: Bearer secret + x-trainertwin-org-id header.
 * Body: { personaSlug, skill: SKILL.md, scenario: scenario.json, items: items.json, patterns?: patterns.md, runId? }.
 * Re-sending the same scenario is a no-op; a changed one gets a new version and replaces its items.
 */
export async function POST(request: Request) {
  const actor = await copilotActor(request);
  if (actor instanceof Response) return actor;
  const orgId = actor.org.id;

  const body: unknown = await request.json().catch(() => null);
  const parsed = scenarioIngestSchema.safeParse(body);
  if (parsed.success && parsed.data.kind === "TWIN") return Response.json({ error: "Use the twin skill publisher for twin skills" }, { status: 400 });
  if (!parsed.success) {
    return Response.json({ error: "Invalid scenario payload", issues: parsed.error.issues.slice(0, 10) }, { status: 400 });
  }

  try {
    // Validated, but store the request as sent: zod output moves unknown keys after known ones.
    const result = await ingestScenario(orgId, { ...body as ScenarioIngestInput, kind: "ROLEPLAY" }, { disallowRestore: true });
    return Response.json({ ok: true, scenario: result }, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    if (error instanceof ScenarioIngestError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[API:internal:scenarios] ingest failed:", error);
    return Response.json({ error: "Could not store the scenario" }, { status: 500 });
  }
}
import { AppError, errorResponse } from "@/lib/errors";

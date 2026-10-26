import { timingSafeEqual } from "node:crypto";
import { ingestScenario, ScenarioIngestError, scenarioIngestSchema } from "@/lib/scenario-ingest";

export const runtime = "nodejs";
export const maxDuration = 120;

// Its own secret: the ingest agent is a separate deployment and should not hold the copilot secret.
function authorized(request: Request) {
  const expected = process.env.SCENARIO_INGEST_SECRET;
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Stores one scenario from the scenario-ingest agent and makes it available as a role play.
 * Same contract shape as the copilot's /api/copilot/studio: Bearer secret + x-trainertwin-org-id header.
 * Body: { personaSlug, skill: SKILL.md text, scenario: scenario.json, items: items.json }.
 * Re-sending the same scenario updates it (new version) and replaces its items.
 */
export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const orgId = request.headers.get("x-trainertwin-org-id")?.trim();
  if (!orgId) return Response.json({ error: "Organization is required" }, { status: 400 });

  const parsed = scenarioIngestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid scenario payload", issues: parsed.error.issues.slice(0, 10) }, { status: 400 });
  }

  try {
    const result = await ingestScenario(orgId, parsed.data);
    return Response.json({ ok: true, scenario: result }, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof ScenarioIngestError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[API:internal:scenarios] ingest failed:", error);
    return Response.json({ error: "Could not store the scenario" }, { status: 500 });
  }
}

import { ingestAuthorized, ingestScenarioRun, ScenarioIngestError, scenarioRunSchema, type ScenarioRunInput } from "@/lib/scenario-ingest";

export const runtime = "nodejs";

/**
 * Archives one scenario-ingest run's files to S3: { runId, plan: plan.json, report: report.md, specs: { <id>: specs/<id>.md } }.
 * Call once per run, before sending its scenarios to /api/internal/scenarios with the same runId.
 */
export async function POST(request: Request) {
  if (!ingestAuthorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const orgId = request.headers.get("x-trainertwin-org-id")?.trim();
  if (!orgId) return Response.json({ error: "Organization is required" }, { status: 400 });

  const body: unknown = await request.json().catch(() => null);
  const parsed = scenarioRunSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid run payload", issues: parsed.error.issues.slice(0, 10) }, { status: 400 });
  }

  try {
    // Validated, but store the request as sent: zod output moves unknown keys after known ones.
    return Response.json({ ok: true, run: await ingestScenarioRun(orgId, body as ScenarioRunInput) });
  } catch (error) {
    if (error instanceof ScenarioIngestError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[API:internal:scenario-runs] archive failed:", error);
    return Response.json({ error: "Could not store the run" }, { status: 500 });
  }
}

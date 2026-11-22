import { copilotActor } from "@/lib/copilot-actor";
import { AppError, errorResponse } from "@/lib/errors";
import { copilotStudioInput, runCopilotStudio } from "@/lib/copilot-studio";
import { ScenarioIngestError } from "@/lib/scenario-ingest";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const actor = await copilotActor(request);
  if (actor instanceof Response) return actor;

  const parsed = copilotStudioInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request", issues: parsed.error.issues.slice(0, 5) }, { status: 400 });

  try {
    const result = await runCopilotStudio(actor, parsed.data);
    return Response.json(result);
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    if (error instanceof ScenarioIngestError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("[API:internal:copilot-studio] failed:", error);
    return Response.json({ error: "The studio action failed" }, { status: 500 });
  }
}

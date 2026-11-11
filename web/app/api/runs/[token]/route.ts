import { getRun } from "workflow/api";
import { studioOrRefusal } from "@/lib/org";
import { progressRun } from "@/lib/run-progress";

/**
 * A workflow run's progress as it happens (newline-delimited JSON, one event per line; ends with the run's stream).
 * Studio only, and only for a run its own org started (lib/run-progress.ts). Used by the assign screens to show
 * invite emails going out (workflows/invite-emails.ts).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const org = await studioOrRefusal();
  if (org instanceof Response) return org;
  const runId = progressRun(org.id, (await params).token);
  if (!runId) return Response.json({ error: "Not found" }, { status: 404 });
  const run = getRun(runId);
  if (!(await run.exists)) return Response.json({ error: "Not found" }, { status: 404 });
  const encoder = new TextEncoder();
  const lines = run.getReadable().pipeThrough(new TransformStream({
    transform(event, controller) {
      controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    },
  }));
  return new Response(lines, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}

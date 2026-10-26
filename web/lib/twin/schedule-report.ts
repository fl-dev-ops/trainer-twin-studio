import { start } from "workflow/api";
import { db } from "@/lib/db";
import { twinSessionReport } from "@/workflows/twin-session-report";

/**
 * Claims a completed twin session (reportStatus none/failed → generating) and starts its report workflow.
 * The claim is the dedupe: browser finalize and the agent webhook both call this, only one run starts.
 */
export async function scheduleTwinReport(sessionId: string) {
  const claimed = await db.interviewSession.updateMany({
    where: { id: sessionId, status: "completed", OR: [{ reportStatus: null }, { reportStatus: "none" }, { reportStatus: "failed" }] },
    data: { reportStatus: "generating", reportWorkflowRunId: null },
  });
  if (claimed.count === 0) return false;
  try {
    const run = await start(twinSessionReport, [sessionId]);
    await db.interviewSession.update({ where: { id: sessionId }, data: { reportWorkflowRunId: run.runId } });
    return true;
  } catch (error) {
    // Not stranded in "generating": the next completion event (or the reprocess script) can claim it again.
    await db.interviewSession.updateMany({ where: { id: sessionId, reportStatus: "generating" }, data: { reportStatus: "failed" } });
    throw error;
  }
}

import { db } from "@/lib/db";
import { scheduleSessionReport } from "@/lib/session-report-jobs";
import { scheduleTwinReport } from "@/lib/twin/session-report";

/**
 * Runs once a session is completed: picks the report for its kind.
 * Twin learner session → twin report; twin calibration → nothing (ratings are saved during the call);
 * everything else → the roleplay report, unchanged.
 */
export async function processCompletedSession(sessionId: string): Promise<boolean> {
  const session = await db.interviewSession.findUnique({
    where: { id: sessionId },
    select: { agent: { select: { kind: true } }, twinCalibration: { select: { id: true } } },
  });
  if (!session) return false;
  if (session.agent.kind !== "TWIN") return scheduleSessionReport(sessionId);
  if (session.twinCalibration) return false;
  return scheduleTwinReport(sessionId);
}

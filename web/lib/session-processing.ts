import { db } from "@/lib/db";
import { scheduleSessionReport } from "@/lib/session-report-jobs";
import { scheduleRoleplayReport, scheduleTwinReport } from "@/lib/schedule-report";
import { reportKindOf } from "@/lib/session-after";

export { reportKindOf, type ReportKind } from "@/lib/session-after";

/**
 * Runs once a session is completed: processes it the way its agent's `after` says.
 * Twin report → learner sessions only (a calibration's ratings are saved during the call, nothing to process);
 * role play → the role-play report workflow (goals, rubric); session → the existing report.
 */
export async function processCompletedSession(sessionId: string): Promise<boolean> {
  const session = await db.interviewSession.findUnique({
    where: { id: sessionId },
    select: { agent: { select: { kind: true, data: true } }, twinCalibration: { select: { id: true } } },
  });
  if (!session) return false;
  const report = reportKindOf(session.agent.data, session.agent.kind);
  if (report === "roleplay") return scheduleRoleplayReport(sessionId);
  if (report === "session") return scheduleSessionReport(sessionId);
  if (session.twinCalibration) return false;
  return scheduleTwinReport(sessionId);
}

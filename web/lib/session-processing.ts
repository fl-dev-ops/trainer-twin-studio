import { db } from "@/lib/db";
import { scheduleSessionReport } from "@/lib/session-report-jobs";
import { scheduleTwinReport } from "@/lib/twin/schedule-report";

/**
 * After the call: how a finished session is processed (Agent.data.after.report, plans/roleplay-skill.md).
 * Without an `after` block: twins get the twin report, everything else the existing session report.
 */
export type ReportKind = "twin" | "roleplay" | "session";

export function reportKindOf(data: unknown, kind: string | null | undefined): ReportKind {
  const after = data && typeof data === "object" ? (data as { after?: { report?: unknown } }).after : undefined;
  if (after?.report === "twin" || after?.report === "roleplay") return after.report;
  return kind === "TWIN" ? "twin" : "session";
}

/**
 * Runs once a session is completed: processes it the way its agent's `after` says.
 * Twin report → learner sessions only (a calibration's ratings are saved during the call, nothing to process);
 * role play → the session report for now (moves to its own processing next); session → the existing report.
 */
export async function processCompletedSession(sessionId: string): Promise<boolean> {
  const session = await db.interviewSession.findUnique({
    where: { id: sessionId },
    select: { agent: { select: { kind: true, data: true } }, twinCalibration: { select: { id: true } } },
  });
  if (!session) return false;
  const report = reportKindOf(session.agent.data, session.agent.kind);
  if (report !== "twin") return scheduleSessionReport(sessionId);
  if (session.twinCalibration) return false;
  return scheduleTwinReport(sessionId);
}

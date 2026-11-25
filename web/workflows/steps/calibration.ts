import { db } from "@/lib/db";
import { scoreCalibrationOnce } from "@/lib/twin/calibration-score";

/**
 * Calibration steps of the end-twin-session workflow (../end-twin-session.ts; specs/practice.md rule 14).
 */

/** "none": not a calibration; "waiting": the agent's final transcript has not arrived; "ready": score it. */
export async function readCalibration(sessionId: string): Promise<"none" | "waiting" | "ready"> {
  "use step";
  const row = await db.interviewSession.findUnique({ where: { id: sessionId }, select: { mode: true, evidence: true, twinCalibration: { select: { id: true } } } });
  if (!row?.twinCalibration) return "none";
  // A card calibration is text: no voice agent transcript is coming, its cards are its record.
  if (row.mode === "chat") return "ready";
  const evidence = row.evidence && typeof row.evidence === "object" ? (row.evidence as Record<string, unknown>) : {};
  return evidence.transcriptFinal === true ? "ready" : "waiting";
}

/** Scores it once; Jev failing throws, and the step is retried. */
export async function scoreCalibration(sessionId: string): Promise<void> {
  "use step";
  await scoreCalibrationOnce(sessionId);
}
scoreCalibration.maxRetries = 3;

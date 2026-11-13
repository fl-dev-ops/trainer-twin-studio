import { db } from "@/lib/db";
import { closeLiveKitSession } from "@/lib/livekit";
import { reportKindOf } from "@/lib/session-after";
import { transcriptTurns } from "@/lib/twin/stats";

/** What the end-of-session workflows do with an ended call (lib/session-end.ts; workflows/steps/session-end.ts). */

/** Closes the call's LiveKit room, dispatch and recording. Throws (so a step retries) unless they're already gone. */
export async function closeSessionRoom(sessionId: string) {
  const session = await db.interviewSession.findUnique({
    where: { id: sessionId },
    select: { livekitRoom: true, livekitDispatchId: true, videoEgressId: true },
  });
  if (!session) return;
  await closeLiveKitSession({ room: session.livekitRoom, dispatchId: session.livekitDispatchId, videoEgressId: session.videoEgressId }, { strict: true });
}

/**
 * Which report this ended session gets, if any: a twin learner call ("twin"; completed, or abandoned when the learner
 * spoke; calibrations none), a builder role play ("roleplay", completed only) or a v1 scenario ("session", completed).
 */
export async function reportFor(sessionId: string): Promise<"twin" | "roleplay" | "session" | null> {
  const session = await db.interviewSession.findUnique({
    where: { id: sessionId },
    select: { status: true, transcript: true, agent: { select: { kind: true, data: true } }, twinCalibration: { select: { id: true } } },
  });
  if (!session || (session.status !== "completed" && session.status !== "abandoned")) return null;
  const report = reportKindOf(session.agent.data, session.agent.kind);
  if (report === "twin") {
    if (session.twinCalibration) return null;
    if (session.status === "completed") return "twin";
    return transcriptTurns(session.transcript).some((turn) => turn.who === "learner") ? "twin" : null;
  }
  return session.status === "completed" ? report : null;
}

/**
 * Claims the report (none/failed → generating), so only one end run writes it when a session is ended more than once
 * (browser and agent both report the end). `runId`: this run, which the report page checks while it waits.
 */
export async function claimReport(sessionId: string, runId: string) {
  const claimed = await db.interviewSession.updateMany({
    // Once per call (practice rule 25): a failed report isn't claimed again.
    where: { id: sessionId, status: { in: ["completed", "abandoned"] }, OR: [{ reportStatus: null }, { reportStatus: "none" }] },
    data: { reportStatus: "generating", reportWorkflowRunId: runId },
  });
  return claimed.count === 1;
}

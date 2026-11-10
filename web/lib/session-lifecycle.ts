import type { Prisma } from "@/lib/generated/prisma/client";
import { finalizeInterviewSession, type SessionEndStatus } from "@/lib/interview-sessions";
import { startSessionEnd } from "@/lib/session-end";

/**
 * Ends a call: saves its end right away (status, transcript, evidence; the call charged to the learner's or the org's
 * credits), then, when its status changed (it just ended, or became completed), starts its kind's end workflow
 * (lib/session-end.ts: end-twin-session or end-roleplay-session): close the LiveKit room, charge (once), the report.
 */
export async function closeInterviewSession(
  sessionId: string,
  requested: SessionEndStatus,
  data: { transcript?: unknown; evidence?: unknown; replaceTranscript?: boolean } = {},
) {
  const finalized = await finalizeInterviewSession({
    sessionId,
    requestedStatus: requested,
    transcript: data.transcript as Prisma.InputJsonValue | undefined,
    evidence: data.evidence as Prisma.InputJsonValue | undefined,
    replaceTranscript: data.replaceTranscript,
  });
  if (finalized && finalized.previousStatus !== finalized.finalStatus) await startSessionEnd(finalized.id);
  return finalized;
}

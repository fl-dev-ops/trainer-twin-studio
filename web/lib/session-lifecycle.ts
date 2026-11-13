import type { Prisma } from "@/lib/generated/prisma/client";
import { finalizeInterviewSession, type SessionEndStatus } from "@/lib/interview-sessions";
import { db } from "@/lib/db";
import { failStaleReports } from "@/lib/report-model";
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
  if (finalized?.endedNow) await startSessionEnd(finalized.id);
  return finalized;
}

/** Grace after a call's deadline before the platform ends it (the agent ends it at the deadline itself). */
const DEADLINE_GRACE_SECONDS = 2 * 60;
/** A call without an allowance (a free studio call) ends after this long. */
const UNMETERED_LIMIT_SECONDS = 3 * 60 * 60;
/** A call stuck starting (never became active) ends after this long. */
const ACTIVATING_LIMIT_SECONDS = 10 * 60;

/**
 * Ends, as abandoned, every call still live past its limit (specs/practice.md rule 7): 2 minutes after its deadline,
 * 3 hours after it started without an allowance, 10 minutes stuck starting. The normal end path: charged up to its
 * allowance, token voided, end work started. Returns how many it ended.
 */
export async function sweepStaleCalls() {
  const stale = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "InterviewSession"
    WHERE ("status" = 'activating' AND "createdAt" < now() AT TIME ZONE 'UTC' - make_interval(secs => ${ACTIVATING_LIMIT_SECONDS}))
       OR ("status" = 'active' AND "startedAt" IS NOT NULL AND "startedAt" + make_interval(secs =>
            coalesce("allowedSeconds" + ${DEADLINE_GRACE_SECONDS}, ${UNMETERED_LIMIT_SECONDS})) < now() AT TIME ZONE 'UTC')
    LIMIT 200`;
  let ended = 0;
  // Calls that ended within the last day whose end work never started (rule 24).
  const unstarted = await db.interviewSession.findMany({
    where: {
      status: { in: ["completed", "abandoned"] },
      endWorkAt: null,
      endedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000), lte: new Date(Date.now() - 60 * 1000) },
    },
    select: { id: true },
    take: 200,
  });
  for (const { id } of unstarted) await startSessionEnd(id);
  await failStaleReports();
  for (const { id } of stale) {
    try {
      if ((await closeInterviewSession(id, "abandoned"))?.endedNow) ended++;
    } catch (error) {
      console.error(`[session-sweep] ${id}: could not end:`, error);
    }
  }
  return ended;
}

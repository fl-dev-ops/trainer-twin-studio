import { db } from "@/lib/db";
import { closeLiveKitSession } from "@/lib/livekit";
import { closeInterviewSession } from "@/lib/session-lifecycle";

export async function expirePublicCall(sessionId: string) {
  "use step";
  const row = await db.interviewSession.findFirst({
    where: { id: sessionId, anonymousId: { not: null } },
    select: { id: true, startedAt: true, allowedSeconds: true, livekitRoom: true, livekitDispatchId: true, videoEgressId: true },
  });
  if (!row?.startedAt || row.allowedSeconds == null) return;
  if (row.startedAt.getTime() + row.allowedSeconds * 1000 > Date.now()) throw new Error("Public call deadline has not arrived");
  await closeLiveKitSession({ room: row.livekitRoom ?? row.id, dispatchId: row.livekitDispatchId, videoEgressId: row.videoEgressId }, { strict: true });
  await closeInterviewSession(row.id, "abandoned");
}
expirePublicCall.maxRetries = 5;

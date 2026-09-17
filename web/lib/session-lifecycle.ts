import { db } from "@/lib/db";
import { closeLiveKitSession } from "@/lib/livekit";
import type { SessionEndStatus } from "@/lib/interview-sessions";

export async function closeInterviewSession(
  sessionId: string,
  requested: SessionEndStatus,
  data: { transcript?: unknown; evidence?: unknown; s3AudioKey?: string } = {},
) {
  const session = await db.interviewSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      status: true,
      livekitRoom: true,
      livekitDispatchId: true,
      audioEgressId: true,
      videoEgressId: true,
    },
  });
  if (!session) return null;
  if (["completed", "abandoned", "failed"].includes(session.status)) return session.status;

  await db.interviewSession.update({ where: { id: session.id }, data: { status: "closing" } });
  await closeLiveKitSession({
    room: session.livekitRoom,
    dispatchId: session.livekitDispatchId,
    audioEgressId: session.audioEgressId,
    videoEgressId: session.videoEgressId,
  });
  await db.interviewSession.update({
    where: { id: session.id },
    data: {
      status: requested,
      endedAt: new Date(),
      runtimeTokenHash: null,
      ...(data.transcript !== undefined ? { transcript: data.transcript as object } : {}),
      ...(data.evidence !== undefined ? { evidence: data.evidence as object } : {}),
      ...(data.s3AudioKey ? { s3AudioKey: data.s3AudioKey } : {}),
    },
  });
  return requested;
}

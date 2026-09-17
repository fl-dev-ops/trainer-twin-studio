import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { closeLiveKitSession } from "@/lib/livekit";
import { finalizeInterviewSession, type SessionEndStatus } from "@/lib/interview-sessions";

export async function closeInterviewSession(
  sessionId: string,
  requested: SessionEndStatus,
  data: { transcript?: unknown; evidence?: unknown; s3AudioKey?: string } = {},
) {
  const session = await db.interviewSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      livekitRoom: true,
      livekitDispatchId: true,
      audioEgressId: true,
      videoEgressId: true,
    },
  });
  if (!session) return null;
  await closeLiveKitSession({
    room: session.livekitRoom,
    dispatchId: session.livekitDispatchId,
    audioEgressId: session.audioEgressId,
    videoEgressId: session.videoEgressId,
  });
  return finalizeInterviewSession({
    sessionId: session.id,
    requestedStatus: requested,
    transcript: data.transcript as Prisma.InputJsonValue | undefined,
    evidence: data.evidence as Prisma.InputJsonValue | undefined,
    s3AudioKey: data.s3AudioKey,
  });
}

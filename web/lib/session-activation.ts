import { db } from "@/lib/db";
import { activateSession } from "@/lib/interview-sessions";
import { activateLiveKitSession, closeLiveKitSession } from "@/lib/livekit";
import type { DeliveryMode } from "@/lib/deployments";

export async function activateInterviewRuntime(input: {
  orgId: string;
  userId: string;
  userName?: string;
  shareCode?: string;
  agentSlug?: string;
  deploymentKey?: string;
  contextId?: string;
  mode: DeliveryMode;
  idempotencyKey?: string;
}) {
  const session = await activateSession(input);
  if (!session) return null;
  if (input.mode === "chat") {
    return { session, conversationToken: session.runtimeToken };
  }

  const row = await db.interviewSession.findUniqueOrThrow({
    where: { id: session.id },
    select: {
      id: true,
      assignmentId: true,
      agentSlug: true,
      agent: { select: { data: true } },
      livekitRoom: true,
      livekitDispatchId: true,
      audioEgressId: true,
      videoEgressId: true,
    },
  });
  const agentData = row.agent.data as { introVideo?: unknown; voiceId?: unknown } | null;
  const configuredVoiceId = typeof agentData?.voiceId === "string" ? agentData.voiceId : "";
  const configuredVoice = configuredVoiceId
    ? await db.voice.findFirst({
        where: { id: configuredVoiceId, status: "ready", OR: [{ orgId: input.orgId }, { orgId: null }] },
        select: { id: true },
      })
    : null;
  const sharedDefault = configuredVoice ? null : await db.voice.findFirst({
    where: { status: "ready", orgId: null },
    orderBy: { name: "asc" },
    select: { id: true },
  });

  try {
    const livekit = await activateLiveKitSession({
      sessionId: session.id,
      userId: input.userId,
      userName: input.userName,
      runtimeToken: session.runtimeToken,
      orgId: input.orgId,
      agentSlug: row.agentSlug,
      holdOpening: Boolean(agentData?.introVideo),
      voice: configuredVoice?.id ?? sharedDefault?.id,
    });
    await db.interviewSession.update({
      where: { id: session.id },
      data: {
        livekitRoom: livekit.room,
        livekitDispatchId: livekit.dispatchId,
        audioEgressId: livekit.audioEgressId,
        s3AudioKey: livekit.audioS3Key,
      },
    });
    return { session, participantToken: livekit.token, room: livekit.room };
  } catch (error) {
    await closeLiveKitSession({
      room: row.livekitRoom,
      dispatchId: row.livekitDispatchId,
      audioEgressId: row.audioEgressId,
      videoEgressId: row.videoEgressId,
    }).catch(() => {});
    await db.$transaction([
      db.interviewSession.update({
        where: { id: session.id },
        data: { status: "failed", endedAt: new Date(), runtimeTokenHash: null },
      }),
      ...(row.assignmentId
        ? [db.rolePlayAssignment.update({ where: { id: row.assignmentId }, data: { status: "pending", usedAt: null } })]
        : []),
    ]);
    throw error;
  }
}

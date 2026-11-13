import { BEFORE_UPLOAD_REFUSED } from "@/lib/context-upload";
import { db } from "@/lib/db";
import { activateSession } from "@/lib/interview-sessions";
import { activateLiveKitSession, closeLiveKitSession } from "@/lib/livekit";
import { AppError, refusals } from "@/lib/errors";
import { MinutesError } from "@/lib/minutes";
import type { DeliveryMode } from "@/lib/deployments";

/**
 * Starting a call (POST /api/sessions), in two parts the start-session workflow runs as steps
 * (workflows/start-session.ts): openSession (access, minutes, the session row) and, for voice, connectVoice (LiveKit
 * room, agent dispatch, recording). A refusal the person should see comes back as `{ ok: false }`, not thrown.
 */

export type StartSessionInput = {
  orgId: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  shareCode?: string;
  agentSlug?: string;
  contextId?: string;
  mode: DeliveryMode;
  idempotencyKey?: string;
  /** The page releases the opening itself ("begin-opening"), e.g. after its get-ready countdown. */
  holdOpening?: boolean;
  /** A studio member calibrating a twin: the call's calibration is created with it (specs/practice.md rule 12). */
  calibrate?: boolean;
};

export type OpenedSession = NonNullable<Awaited<ReturnType<typeof activateSession>>>;
/** `code`: "minutes" for credits refusals, else our refusal code (lib/errors.ts) when there is one. */
export type Refusal = { ok: false; status: number; error: string; code?: string };
export type SessionStart =
  | Refusal
  | { ok: true; session: OpenedSession; conversationToken?: string; participantToken?: string; room?: string };

/** A refusal the person should see (access, minutes, documents), with its HTTP status; anything else: null. */
export function startRefusal(error: unknown): Refusal | null {
  if (error instanceof MinutesError) return { ok: false, status: error.status, error: error.message, code: "minutes" };
  if (error instanceof AppError) return { ok: false, status: error.status, error: error.message, code: error.code };
  const message = error instanceof Error ? error.message : "";
  if (message === "Context not found" || message === BEFORE_UPLOAD_REFUSED || message.startsWith("Deployment does not allow ")) {
    return { ok: false, status: 400, error: message };
  }
  return null;
}

/** Step 1: checks access and minutes and creates (or resumes) the session. */
export async function openSession(input: StartSessionInput): Promise<Refusal | { ok: true; session: OpenedSession }> {
  try {
    const session = await activateSession(input);
    // Null: a code that isn't a link of this org (or a used one-off start): answered like an unknown one.
    return session ? { ok: true, session } : (startRefusal(refusals.notFound()) as Refusal);
  } catch (error) {
    const refusal = startRefusal(error);
    if (refusal) return refusal;
    throw error;
  }
}

/** Both parts in order, without the workflow (when it can't start). */
export async function startSessionNow(input: StartSessionInput): Promise<SessionStart> {
  const opened = await openSession(input);
  if (!opened.ok) return opened;
  if (input.mode === "chat") return { ...opened, conversationToken: opened.session.agentToken };
  return { ...opened, ...(await connectVoice(input, opened.session)) };
}

/** Step 2 (voice): the session's LiveKit room, the agent's dispatch and the recording. Failed: the session is closed. */
export async function connectVoice(input: StartSessionInput, session: OpenedSession): Promise<{ participantToken: string; room: string }> {
  const row = await db.interviewSession.findUniqueOrThrow({
    where: { id: session.id },
    select: {
      id: true,
      agentSlug: true,
      agent: { select: { data: true, kind: true, persona: { select: { voiceId: true } } } },
      livekitRoom: true,
      livekitDispatchId: true,
      audioEgressId: true,
      videoEgressId: true,
    },
  });
  const agentData = row.agent.data as { introVideo?: unknown; voiceId?: unknown } | null;
  // The agent's own voice (an explicit override) wins; otherwise the voice its persona owns.
  const configuredVoiceId = typeof agentData?.voiceId === "string" && agentData.voiceId ? agentData.voiceId : row.agent.persona.voiceId ?? "";
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
      runtimeToken: session.agentToken,
      orgId: input.orgId,
      agentSlug: row.agentSlug,
      holdOpening: Boolean(agentData?.introVideo) || Boolean(input.holdOpening),
      voice: configuredVoice?.id ?? sharedDefault?.id,
      // Learner minutes: the voice agent ends the call at this moment (absolute, so agent and web count the same span).
      endsAt: "secondsLeft" in session && session.secondsLeft != null
        ? Math.floor(Date.now() / 1000) + session.secondsLeft
        : undefined,
      agentKind: row.agent.kind,
    });
    await db.interviewSession.update({
      where: { id: session.id },
      data: {
        livekitRoom: livekit.room,
        livekitDispatchId: livekit.dispatchId,
        videoEgressId: livekit.videoEgressId,
        ...(livekit.videoS3Key
          ? {
              evidence: {
                videoS3Key: livekit.videoS3Key,
              },
            }
          : {}),
      },
    });
    return { participantToken: livekit.token, room: livekit.room };
  } catch (error) {
    // Joining a live call (a resume) failing never fails that call (specs/practice.md rule 18).
    if ("resumed" in session && session.resumed) throw error;
    await closeLiveKitSession({
      room: row.livekitRoom,
      dispatchId: row.livekitDispatchId,
      videoEgressId: row.videoEgressId,
    }).catch(() => {});
    await db.interviewSession.updateMany({
      where: { id: session.id, status: { in: ["activating", "active"] } },
      data: { status: "failed", endedAt: new Date(), runtimeTokenHash: null },
    });
    throw error;
  }
}

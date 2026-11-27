import { BEFORE_UPLOAD_REFUSED } from "@/lib/context-upload";
import { db, withLock } from "@/lib/db";
import { activateSession, publicSessionExpired, resolveVoiceForSession } from "@/lib/interview-sessions";
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
  /** A studio member trying a role play with several personas: the persona to play (slug); omitted = random. */
  persona?: string;
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
  requireVoiceMode(input.mode);
  const row = await db.interviewSession.findFirst({
    where: { id: session.id, ...sessionOwner(input) },
    select: {
      id: true,
      mode: true,
      agentSlug: true,
      resolvedVoiceId: true,
      compiledSnapshot: true,
      agent: { select: { data: true, kind: true, persona: { select: { voiceId: true } } } },
      livekitRoom: true,
      livekitDispatchId: true,
      audioEgressId: true,
      videoEgressId: true,
      startedAt: true,
      allowedSeconds: true,
      anonymousId: true,
      personaSlug: true,
    },
  });
  if (!row) throw refusals.notFound();
  requireVoiceMode(row.mode);
  // Role-play pages request the opening hold themselves; clients without intro playback must not wait for it.
  const roleplay = row.agent.kind === "ROLEPLAY";
  const agentData = row.agent.data as { introVideo?: unknown; voiceId?: unknown } | null;

  try {
    const voiceId = await withLock([`session-voice:${session.id}`], async (tx) => {
      const current = await tx.interviewSession.findFirst({
        where: { id: session.id, ...sessionOwner(input) },
        select: { resolvedVoiceId: true, mode: true },
      });
      if (!current) throw refusals.notFound();
      requireVoiceMode(current.mode);
      let configuredVoiceId = current.resolvedVoiceId;
      if (!configuredVoiceId) {
        const snapshot = record(row.compiledSnapshot);
        const snapshotAgent = record(record(snapshot.agent).data);
        const snapshotPersona = record(snapshot.persona);
        const recordedVoiceId = [snapshot.voiceId, snapshotAgent.voiceId, snapshotPersona.voiceId, record(snapshotPersona.data).voiceId]
          .find((value) => value != null && value !== "");
        if (recordedVoiceId != null && typeof recordedVoiceId !== "string") {
          throw refusals.invalidInput("The recorded voice is invalid. Choose a ready voice before starting a new voice session.");
        }
        if (recordedVoiceId == null && agentData?.voiceId != null && agentData.voiceId !== "" && typeof agentData.voiceId !== "string") {
          throw refusals.invalidInput("The selected voice is invalid. Choose a ready voice before starting a voice session.");
        }
        // NULL legacy rows have no historical pin: record the compatibility resolution now, not as their original voice.
        configuredVoiceId = recordedVoiceId
          ?? (typeof agentData?.voiceId === "string" && agentData.voiceId ? agentData.voiceId : row.agent.persona.voiceId);
      }
      const resolved = await resolveVoiceForSession(input.orgId, configuredVoiceId, tx);
      if (!current.resolvedVoiceId) {
        await tx.interviewSession.update({ where: { id: session.id }, data: { resolvedVoiceId: resolved } });
      }
      return resolved;
    });
    const livekit = await activateLiveKitSession({
      sessionId: session.id,
      userId: input.userId,
      userName: input.userName,
      runtimeToken: session.agentToken,
      orgId: input.orgId,
      agentSlug: row.agentSlug,
      holdOpening: row.anonymousId ? false : (!roleplay && Boolean(agentData?.introVideo)) || Boolean(input.holdOpening),
      voice: voiceId,
      // Learner minutes: the voice agent ends the call at this moment (absolute, so agent and web count the same span).
      endsAt: row.startedAt && row.allowedSeconds != null
        ? Math.floor(row.startedAt.getTime() / 1000) + row.allowedSeconds
        : "secondsLeft" in session && session.secondsLeft != null
          ? Math.floor(Date.now() / 1000) + session.secondsLeft
          : undefined,
      agentKind: row.agent.kind,
      anonymous: Boolean(row.anonymousId),
      personaName: row.personaSlug
        ? (await db.persona.findFirst({
          where: { slug: row.personaSlug, OR: [{ orgId: input.orgId }, { orgId: null }] },
          orderBy: { orgId: { sort: "asc", nulls: "last" } },
          select: { name: true },
        }))?.name
        : undefined,
    });
    if (row.anonymousId) {
      const current = await db.interviewSession.findUnique({
        where: { id: session.id },
        select: { status: true, anonymousId: true, allowedSeconds: true, startedAt: true, deletedAt: true },
      });
      if (!current || current.status !== "active" || publicSessionExpired(current)) throw refusals.notFound();
    }
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
    if (error instanceof AppError && error.code === "session_mode_mismatch") throw error;
    // Joining a live call (a resume) failing never fails that call (specs/practice.md rule 18).
    if ("resumed" in session && session.resumed) throw error;
    await closeLiveKitSession({
      room: row.livekitRoom ?? session.id,
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

/** The learner's own session, or an anonymous public call (no user; started by lib/public-twin-sessions.ts). */
function sessionOwner(input: StartSessionInput) {
  return { orgId: input.orgId, OR: [{ userId: input.userId }, { userId: null, anonymousId: { not: null } }] };
}

function requireVoiceMode(mode: string) {
  if (mode !== "voice") throw new AppError("session_mode_mismatch", "Voice connections require voice mode.", 409);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

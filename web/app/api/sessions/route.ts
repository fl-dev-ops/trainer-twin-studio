import { NextResponse } from "next/server";
import { activateSession, authorizeRuntimeSession } from "@/lib/interview-sessions";
import { createLiveKitSessionToken } from "@/lib/livekit";
import { prewarmSessionOpening } from "@/lib/runtime/warmup";
import { getSessionOrg } from "@/lib/org";
import { resolveSessionUser } from "@/lib/session-user";
import { db } from "@/lib/db";
import { listSessions } from "@/lib/specs";

export async function GET() {
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ sessions: await listSessions(org.id) });
}

/** Authenticated learner activation. The DB record always exists before WebRTC starts. */
export async function POST(req: Request) {
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || (!body.shareCode && !body.agentSlug)) {
    return NextResponse.json({ error: "shareCode or agentSlug is required" }, { status: 400 });
  }
  const member = await db.member.findFirst({
    where: { organizationId: org.id, userId: user.id },
    select: { id: true },
  });
  if (!member) return NextResponse.json({ error: "Invalid session URL" }, { status: 403 });

  try {
    const session = await activateSession({
      orgId: org.id,
      userId: user.id,
      shareCode: typeof body.shareCode === "string" ? body.shareCode : undefined,
      agentSlug: typeof body.agentSlug === "string" ? body.agentSlug : undefined,
      contextId: typeof body.contextId === "string" ? body.contextId : undefined,
      contextIds: Array.isArray(body.contextIds)
        ? body.contextIds.filter((id: unknown): id is string => typeof id === "string")
        : undefined,
    });
    if (!session) return NextResponse.json({ error: "Invalid session URL" }, { status: 403 });

    // Pre-warm opening turn and Vercel AI Gateway KV-cache in background while WebRTC connects
    void prewarmSessionOpening(session.id);

    let livekit = null;
    let livekitError: string | undefined;
    try {
      // The agent holds its greeting only when the scenario ships an intro clip; the
      // flag rides in room metadata so the agent worker can honor it per-session.
      const agentRow = session.agentSlug
        ? await db.agent.findFirst({
            where: { orgId: org.id, slug: session.agentSlug },
            select: { data: true },
          })
        : null;
      const agentData = agentRow?.data as { introVideo?: unknown; voiceId?: unknown } | null;
      const holdOpening = Boolean(agentData?.introVideo);
      // Agent Studio configuration is authoritative. Custom voices are used only
      // by agents explicitly configured with their voiceId; otherwise use a
      // shared sample voice, never another org/custom voice.
      const configuredVoiceId = typeof agentData?.voiceId === "string" ? agentData.voiceId : "";
      const configuredVoice = configuredVoiceId
        ? await db.voice.findFirst({
            where: { id: configuredVoiceId, status: "ready", OR: [{ orgId: org.id }, { orgId: null }] },
            select: { id: true },
          })
        : null;
      const sharedDefault = configuredVoice
        ? null
        : await db.voice.findFirst({
            where: { status: "ready", orgId: null },
            orderBy: { name: "asc" },
            select: { id: true },
          });
      const voiceId = configuredVoice?.id ?? sharedDefault?.id;
      livekit = await createLiveKitSessionToken({
        sessionId: session.id,
        userId: user.id,
        userName: user.name,
        runtimeToken: session.runtimeToken,
        orgId: org.id,
        agentSlug: session.agentSlug,
        holdOpening,
        voice: voiceId,
      });
    } catch (tokenErr) {
      console.error("Failed to start LiveKit session:", tokenErr);
      livekitError = "Voice service unavailable. Check the LiveKit configuration and agent deployment.";
    }

    return NextResponse.json({ session, livekit, livekitError });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Session creation failed" }, { status: 400 });
  }
}

/** Agent-only lifecycle update authorized by the session-scoped runtime token. */
export async function PATCH(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body?.id || !["completed", "abandoned"].includes(body.status)) {
    return NextResponse.json({ error: "id and status are required" }, { status: 400 });
  }
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const session = await authorizeRuntimeSession(String(body.id), token);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await db.$transaction([
    db.interviewSession.update({
      where: { id: session.id },
      data: {
        status: body.status,
        endedAt: new Date(),
        runtimeTokenHash: null,
        ...(typeof body.s3AudioKey === "string" ? { s3AudioKey: body.s3AudioKey } : {}),
      },
    }),
    db.rolePlayAssignment.deleteMany({ where: { sessionId: session.id } }),
  ]);
  return NextResponse.json({ ok: true });
}

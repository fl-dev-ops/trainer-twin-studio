import { NextResponse } from "next/server";
import { activateSession, authorizeRuntimeSession } from "@/lib/interview-sessions";
import { createLiveKitSessionToken } from "@/lib/livekit";
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
    });
    if (!session) return NextResponse.json({ error: "Invalid session URL" }, { status: 403 });

    let livekit = null;
    try {
      livekit = await createLiveKitSessionToken({
        sessionId: session.id,
        userId: user.id,
        userName: user.name,
        runtimeToken: session.runtimeToken,
        orgId: org.id,
        agentSlug: session.agentSlug,
      });
    } catch (tokenErr) {
      console.warn("Failed to create LiveKit token:", tokenErr);
    }

    return NextResponse.json({ session, livekit });
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

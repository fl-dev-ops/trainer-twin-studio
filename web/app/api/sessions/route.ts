import { orgPerson } from "@/lib/org-people";
import { NextResponse } from "next/server";
import { authorizeRuntimeSession, type SessionEndStatus } from "@/lib/interview-sessions";
import { closeInterviewSession } from "@/lib/session-lifecycle";
import { after } from "next/server";
import { runSessionStart } from "@/lib/run-session-start";
import { warmChatOpening } from "@/lib/session-warm";
import { getTrainerOrg } from "@/lib/org";
import { resolveSessionUser } from "@/lib/session-user";
import { isStudioRole } from "@/lib/org";
import { listSessions } from "@/lib/specs";

export async function GET() {
  const trainer = await getTrainerOrg();
  if (!trainer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ sessions: await listSessions(trainer.id) });
}

/** Learner-triggered activation. No runtime or LiveKit resources exist before this call. */
export async function POST(req: Request) {
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || (!body.shareCode && !body.agentSlug && !body.deploymentKey)) {
    return NextResponse.json({ error: "shareCode, agentSlug, or deploymentKey is required" }, { status: 400 });
  }
  if (!body.shareCode) {
    const member = await orgPerson(org.id, { userId: user.id });
    if (!member) return NextResponse.json({ error: "Invalid session URL" }, { status: 403 });
    // Starting an agent by slug skips assignments and minutes: studio members (admin, team) trying it only.
    if (!body.deploymentKey && !isStudioRole(member.role)) return NextResponse.json({ error: "Invalid session URL" }, { status: 403 });
  }

  try {
    // The start-session workflow (workflows/start-session.ts): access, minutes, the session, then its voice room.
    const started = await runSessionStart({
      orgId: org.id,
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      shareCode: typeof body.shareCode === "string" ? body.shareCode : undefined,
      agentSlug: typeof body.agentSlug === "string" ? body.agentSlug : undefined,
      deploymentKey: typeof body.deploymentKey === "string" ? body.deploymentKey : undefined,
      contextId: typeof body.contextId === "string" ? body.contextId : undefined,
      mode: body.mode === "chat" ? "chat" : "voice",
      idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
      holdOpening: body.holdOpening === true,
    });
    if (!started.ok) return NextResponse.json({ error: started.error, ...(started.code ? { code: started.code } : {}) }, { status: started.status });
    const activation = { session: started.session, participantToken: started.participantToken, room: started.room, conversationToken: started.conversationToken };
    // Prewarm the chat brain's opening (spec snapshot, surface command, opening style) while the person connects.
    after(() => warmChatOpening(activation.session.id, org.id).catch(() => {}));
    return NextResponse.json(activation);
  } catch (error) {
    console.error("Session activation failed", error);
    return NextResponse.json({ error: "Could not start the session. Please try again or contact support." }, { status: 500 });
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
  // The rest (room, credits, report) runs in the session's end workflow (lib/session-lifecycle.ts).
  await closeInterviewSession(session.id, body.status as SessionEndStatus);
  return NextResponse.json({ ok: true });
}

import { errorResponse, refusals } from "@/lib/errors";
import { practicePerson, practiceRefusals } from "@/lib/practice";
import { NextResponse } from "next/server";
import { authorizeRuntimeSession, type SessionEndStatus } from "@/lib/interview-sessions";
import { closeInterviewSession } from "@/lib/session-lifecycle";
import { after } from "next/server";
import { runSessionStart } from "@/lib/run-session-start";
import { warmChatOpening } from "@/lib/session-warm";
import { studioOrRefusal } from "@/lib/org";
import { resolveSessionUser } from "@/lib/session-user";
import { isStudioRole } from "@/lib/org";
import { listSessions } from "@/lib/specs";

export async function GET() {
  const trainer = await studioOrRefusal();
  if (trainer instanceof Response) return trainer;
  return NextResponse.json({ sessions: await listSessions(trainer.id) });
}

/** Learner-triggered activation. No runtime or LiveKit resources exist before this call. */
export async function POST(req: Request) {
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return errorResponse(refusals.signedOut());
  const body = await req.json().catch(() => null);
  if (!body || (!body.shareCode && !body.agentSlug)) {
    return errorResponse(refusals.invalidInput("shareCode or agentSlug is required"));
  }
  if (!body.shareCode) {
    const member = await practicePerson(org.id, user.id).catch((error: unknown) => errorResponse(error));
    if (member instanceof Response) return member;
    // Starting an agent by slug skips assignments: studio members (admin, team) trying it only.
    if (!isStudioRole(member.role)) return errorResponse(refusals.studioOnly());
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
      contextId: typeof body.contextId === "string" ? body.contextId : undefined,
      mode: body.mode === "chat" ? "chat" : "voice",
      idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
      holdOpening: body.holdOpening === true,
      calibrate: body.calibrate === true,
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
  if (!session) return errorResponse(practiceRefusals.runtimeTokenInvalid());
  // The rest (room, credits, report) runs in the session's end workflow (lib/session-lifecycle.ts).
  await closeInterviewSession(session.id, body.status as SessionEndStatus);
  return NextResponse.json({ ok: true });
}

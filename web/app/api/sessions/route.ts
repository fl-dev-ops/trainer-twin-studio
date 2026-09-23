import { NextResponse } from "next/server";
import { authorizeRuntimeSession, type SessionEndStatus } from "@/lib/interview-sessions";
import { closeInterviewSession } from "@/lib/session-lifecycle";
import { activateInterviewRuntime } from "@/lib/session-activation";
import { getSessionOrg } from "@/lib/org";
import { resolveSessionUser } from "@/lib/session-user";
import { db } from "@/lib/db";
import { listSessions } from "@/lib/specs";
import { scheduleSessionReport } from "@/lib/session-report-jobs";

export async function GET() {
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ sessions: await listSessions(org.id) });
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
    const member = await db.member.findFirst({
      where: { organizationId: org.id, userId: user.id },
      select: { id: true },
    });
    if (!member) return NextResponse.json({ error: "Invalid session URL" }, { status: 403 });
  }

  try {
    const activation = await activateInterviewRuntime({
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
    });
    if (!activation) return NextResponse.json({ error: "Invalid or already used session URL" }, { status: 403 });
    return NextResponse.json(activation);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Session activation failed" }, { status: 400 });
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
  const finalized = await closeInterviewSession(session.id, body.status as SessionEndStatus, {
    ...(typeof body.s3AudioKey === "string" ? { s3AudioKey: body.s3AudioKey } : {}),
  });
  if (finalized?.finalStatus === "completed") {
    await scheduleSessionReport(finalized.id).catch((error) => {
      console.warn("Could not initiate session report generation:", error);
    });
  }
  return NextResponse.json({ ok: true });
}

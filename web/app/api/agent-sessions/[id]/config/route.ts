import { NextResponse } from "next/server";
import { authorizeRuntimeSession } from "@/lib/interview-sessions";
import { db } from "@/lib/db";
import { getAgentConfigForAgent } from "@/lib/specs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const session = await authorizeRuntimeSession(id, token);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const config = await getAgentConfigForAgent(session.agentId, session.orgId, session.contextId ?? undefined);
  if (!config) return NextResponse.json({ error: "Session configuration is unavailable" }, { status: 409 });
  if (session.status === "assigned") {
    await db.interviewSession.update({
      where: { id: session.id },
      data: { status: "active", startedAt: new Date() },
    });
  }
  return NextResponse.json({
    ...config,
    session: { id: session.id, orgId: session.orgId, userId: session.userId },
  }, { headers: { "Cache-Control": "no-store" } });
}

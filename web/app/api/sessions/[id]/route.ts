import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { resolveSessionUser } from "@/lib/session-user";
import { authorizeRuntimeSession } from "@/lib/interview-sessions";

/**
 * Returns snapshot of an interview session: coverage, phase, status.
 * Authorizes either via web user session or bearer runtime token.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let session = null;

  // 1. Check bearer runtime token
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (token) {
    const authorized = await authorizeRuntimeSession(token);
    if (authorized && authorized.id === id) {
      session = {
        id: authorized.id,
        status: authorized.status,
        evidence: authorized.evidence,
        runtimeState: authorized.runtimeState,
        runtimeRevision: authorized.runtimeRevision,
      };
    }
  }

  // 2. Fall back to user session if available
  if (!session) {
    try {
      const { org, user } = await resolveSessionUser();
      if (org && user) {
        const member = await db.member.findFirst({
          where: { organizationId: org.id, userId: user.id },
          select: { role: true },
        });
        const trainer = member?.role.split(",").some((role) => ["owner", "admin"].includes(role.trim()));
        session = await db.interviewSession.findFirst({
          where: { id, orgId: org.id, deletedAt: null, ...(trainer ? {} : { userId: user.id }) },
          select: {
            id: true,
            status: true,
            evidence: true,
            runtimeState: true,
            runtimeRevision: true,
          },
        });
      }
    } catch {
      // Outside request context
    }
  }

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const runtimeState = session.runtimeState as Record<string, unknown> | null;
  const coverage = session.evidence ?? runtimeState?.coverage ?? {};
  const phaseIndex = runtimeState?.phase_index ?? 0;

  return NextResponse.json({
    id: session.id,
    status: session.status,
    coverage,
    phase_index: phaseIndex,
    runtimeRevision: session.runtimeRevision,
  });
}

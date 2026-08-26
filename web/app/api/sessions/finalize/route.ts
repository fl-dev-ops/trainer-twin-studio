import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { resolveSessionUser } from "@/lib/session-user";

/**
 * Finalizes a session: persists the transcript and evidence coverage captured
 * by the browser before the user leaves the session page, and stamps identity.
 */
export async function POST(request: Request) {
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body?.sessionId) return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });

  const transcript = Array.isArray(body.transcript)
    ? body.transcript.filter(
        (e: unknown) =>
          typeof e === "object" && e !== null && typeof (e as { text?: unknown }).text === "string",
      )
    : undefined;
  const evidence = typeof body.evidence === "object" && body.evidence !== null ? body.evidence : undefined;

  const updated = await db.interviewSession.updateMany({
    where: { id: String(body.sessionId), orgId: org.id },
    data: {
      userId: user.id,
      ...(transcript ? { transcript } : {}),
      ...(evidence ? { evidence } : {}),
    },
  });
  if (updated.count === 0) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

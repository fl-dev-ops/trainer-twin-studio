import { NextResponse } from "next/server";
import { resolveSessionEndStatus } from "@/lib/interview-sessions";
import { db } from "@/lib/db";

/**
 * Fixed webhook route for LiveKit agent recording & session finalization.
 * Agent sends recording URLs (audio + video), final status, and evaluation reports.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let rawSessionId = String(body.session_id || body.sessionId || body.room_name || "").trim();
  if (!rawSessionId) {
    return NextResponse.json({ error: "Missing session_id or room_name" }, { status: 400 });
  }

  // Normalize room name "session-<id>" to id
  if (rawSessionId.startsWith("session-")) {
    rawSessionId = rawSessionId.slice("session-".length);
  }

  const session = await db.interviewSession.findFirst({
    where: {
      OR: [{ id: rawSessionId }, { shareCode: rawSessionId }],
    },
    select: { id: true, status: true, evidence: true, transcript: true },
  });

  if (!session) {
    return NextResponse.json({ error: `Session not found: ${rawSessionId}` }, { status: 404 });
  }

  const status =
    body.status === "COMPLETED"
      ? resolveSessionEndStatus(session.status, "completed")
      : body.status === "FAILED" || body.status === "ABANDONED"
        ? resolveSessionEndStatus(session.status, "abandoned")
        : session.status;

  const existingEvidence =
    typeof session.evidence === "object" && session.evidence !== null
      ? (session.evidence as Record<string, unknown>)
      : {};

  const updatedEvidence = {
    ...existingEvidence,
    ...(typeof body.report === "object" && body.report !== null ? body.report : {}),
    ...(body.video_url ? { videoUrl: body.video_url } : {}),
    ...(body.video_s3_key ? { videoS3Key: body.video_s3_key } : {}),
    ...(body.audio_url ? { audioUrl: body.audio_url } : {}),
    ...(body.audio_s3_key ? { audioS3Key: body.audio_s3_key } : {}),
    ...(body.metrics ? { metrics: body.metrics } : {}),
  };

  const hasCanonicalTranscript = Array.isArray(session.transcript) && session.transcript.length > 0;
  const newTranscript =
    !hasCanonicalTranscript && Array.isArray(body.transcript) ? body.transcript : undefined;

  await db.$transaction([
    db.interviewSession.update({
      where: { id: session.id },
      data: {
        status,
        endedAt: new Date(),
        runtimeTokenHash: null,
        ...(body.audio_s3_key || body.audio_url
          ? { s3AudioKey: String(body.audio_s3_key || body.audio_url) }
          : {}),
        evidence: updatedEvidence,
        ...(newTranscript ? { transcript: newTranscript } : {}),
      },
    }),
    db.rolePlayAssignment.deleteMany({ where: { sessionId: session.id } }),
  ]);

  return NextResponse.json({ ok: true, sessionId: session.id, status });
}

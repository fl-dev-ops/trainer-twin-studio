import { NextResponse } from "next/server";
import { finalizeInterviewSession, type SessionEndStatus } from "@/lib/interview-sessions";
import { closeInterviewSession } from "@/lib/session-lifecycle";
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { scheduleSessionReport } from "@/lib/session-report-jobs";

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
    select: { id: true },
  });

  if (!session) {
    return NextResponse.json({ error: `Session not found: ${rawSessionId}` }, { status: 404 });
  }

  const requestedStatus: SessionEndStatus | undefined =
    body.status === "COMPLETED"
      ? "completed"
      : body.status === "FAILED" || body.status === "ABANDONED"
        ? "abandoned"
        : undefined;

  const updatedEvidence = {
    ...(typeof body.report === "object" && body.report !== null ? body.report : {}),
    ...(body.video_url ? { videoUrl: body.video_url } : {}),
    ...(body.video_s3_key ? { videoS3Key: body.video_s3_key } : {}),
    ...(body.audio_url ? { audioUrl: body.audio_url } : {}),
    ...(body.audio_s3_key ? { audioS3Key: body.audio_s3_key } : {}),
    ...(body.metrics ? { metrics: body.metrics } : {}),
  };

  const payload = {
    transcript: Array.isArray(body.transcript) ? body.transcript as Prisma.InputJsonValue : undefined,
    evidence: updatedEvidence as Prisma.InputJsonValue,
    s3AudioKey: body.audio_s3_key || body.audio_url
      ? String(body.audio_s3_key || body.audio_url)
      : undefined,
  };
  const finalized = requestedStatus
    ? await closeInterviewSession(session.id, requestedStatus, payload)
    : await finalizeInterviewSession({ sessionId: session.id, ...payload });
  if (!finalized) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  if (finalized.finalStatus === "completed") {
    await scheduleSessionReport(finalized.id).catch((error) => {
      console.warn("Could not initiate session report generation:", error);
    });
  }

  return NextResponse.json({ ok: true, sessionId: session.id, status: finalized.finalStatus });
}

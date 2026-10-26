import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { finalizeInterviewSession, type SessionEndStatus } from "@/lib/interview-sessions";
import { closeInterviewSession } from "@/lib/session-lifecycle";
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { processCompletedSession } from "@/lib/session-processing";

/** Only the LiveKit agent may call this: it holds the shared service secret. */
function authorized(request: Request) {
  const expected = process.env.COPILOT_SERVICE_SECRET;
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

const text = z.string().max(2000).nullish();
const payloadSchema = z.object({
  session_id: z.string().max(200).nullish(),
  sessionId: z.string().max(200).nullish(),
  room_name: z.string().max(200).nullish(),
  status: z.string().max(40).nullish(),
  transcript: z.array(z.object({ role: z.string().max(40), text: z.string().max(50_000) }).passthrough()).max(10_000).nullish(),
  report: z.record(z.string(), z.unknown()).nullish(),
  metrics: z.unknown().optional(),
  video_url: text,
  video_s3_key: text,
  audio_url: text,
  audio_s3_key: text,
  participant_identity: text,
});

/**
 * Fixed webhook route for LiveKit agent recording & session finalization.
 * Agent sends recording URLs (audio + video), final status, and the transcript.
 */
export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = payloadSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid webhook payload", issues: parsed.error.issues.slice(0, 5) }, { status: 400 });
  }
  const body = parsed.data;

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
    select: { id: true, agent: { select: { kind: true } } },
  });

  if (!session) {
    return NextResponse.json({ error: `Session not found: ${rawSessionId}` }, { status: 404 });
  }
  const twin = session.agent.kind === "TWIN";

  const requestedStatus: SessionEndStatus | undefined =
    body.status === "COMPLETED"
      ? "completed"
      : body.status === "FAILED" || body.status === "ABANDONED"
        ? "abandoned"
        : undefined;

  const updatedEvidence = {
    ...(body.report ?? {}),
    ...(body.video_url ? { videoUrl: body.video_url } : {}),
    ...(body.video_s3_key ? { videoS3Key: body.video_s3_key } : {}),
    ...(body.audio_url ? { audioUrl: body.audio_url } : {}),
    ...(body.audio_s3_key ? { audioS3Key: body.audio_s3_key } : {}),
    ...(body.metrics ? { metrics: body.metrics } : {}),
    // Twin reports wait for this: the agent's transcript is the whole conversation, the browser's may be partial.
    ...(twin ? { transcriptFinal: true } : {}),
  };

  const payload = {
    transcript: body.transcript?.length ? body.transcript as Prisma.InputJsonValue : undefined,
    evidence: updatedEvidence as Prisma.InputJsonValue,
    s3AudioKey: body.audio_s3_key || body.audio_url
      ? String(body.audio_s3_key || body.audio_url)
      : undefined,
    replaceTranscript: twin,
  };
  const finalized = requestedStatus
    ? await closeInterviewSession(session.id, requestedStatus, payload)
    : await finalizeInterviewSession({ sessionId: session.id, ...payload });
  if (!finalized) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  if (finalized.finalStatus === "completed") {
    await processCompletedSession(finalized.id).catch((error) => {
      console.warn("Could not initiate session report generation:", error);
    });
  }

  return NextResponse.json({ ok: true, sessionId: session.id, status: finalized.finalStatus });
}

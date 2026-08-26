import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { putObject, recordingKey, s3Configured } from "@/lib/s3";

/**
 * Receives the finished session recording (stereo WAV) from the Pipecat agent.
 * ponytail: unauthenticated like the rest of the agent-facing API; add a shared
 * service secret when this leaves local development.
 */
export async function POST(request: Request) {
  if (!s3Configured) return NextResponse.json({ error: "S3 is not configured" }, { status: 500 });

  const sessionId = new URL(request.url).searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });

  const session = await db.interviewSession.findUnique({
    where: { id: sessionId },
    select: { id: true },
  });
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });

  const wav = new Uint8Array(await request.arrayBuffer());
  if (wav.length === 0) return NextResponse.json({ error: "Empty recording" }, { status: 400 });

  const key = recordingKey(sessionId);
  await putObject(key, wav, "audio/wav");
  await db.interviewSession.update({
    where: { id: sessionId },
    data: { s3AudioKey: key },
  });
  return NextResponse.json({ ok: true, bytes: wav.length });
}

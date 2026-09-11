import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeRuntimeSession } from "@/lib/interview-sessions";
import { putObject, recordingKey, s3Configured } from "@/lib/s3";

/**
 * Receives the finished session recording from the Pipecat agent, authorized
 * by the same session-scoped runtime token used to load its configuration.
 */
export async function POST(request: Request) {
  if (!s3Configured) return NextResponse.json({ error: "S3 is not configured" }, { status: 500 });

  const sessionId = new URL(request.url).searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });

  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const session = await authorizeRuntimeSession(sessionId, token);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const wav = new Uint8Array(await request.arrayBuffer());
  if (wav.length === 0) return NextResponse.json({ error: "Empty recording" }, { status: 400 });

  const key = recordingKey(session.orgId, sessionId);
  await putObject(key, wav, "audio/wav");
  await db.interviewSession.update({
    where: { id: sessionId },
    data: { s3AudioKey: key },
  });
  return NextResponse.json({ ok: true, bytes: wav.length });
}

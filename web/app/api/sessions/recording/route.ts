import { AppError, errorResponse, refusals } from "@/lib/errors";
import { practiceRefusals } from "@/lib/practice";

const MAX_RECORDING_BYTES = 200 * 1024 * 1024;
const recordingTooBig = () => new AppError("recording_too_big", "A recording can be at most 200 MB.", 413);
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
  if (!session) return errorResponse(practiceRefusals.runtimeTokenInvalid());

  // At most MAX_RECORDING_BYTES (specs/practice.md rule 9): refused from its declared size before reading it.
  if (Number(request.headers.get("content-length") ?? 0) > MAX_RECORDING_BYTES) return errorResponse(recordingTooBig());
  const wav = new Uint8Array(await request.arrayBuffer());
  if (wav.length > MAX_RECORDING_BYTES) return errorResponse(recordingTooBig());
  if (wav.length === 0) return errorResponse(refusals.invalidInput("Empty recording"));

  const key = recordingKey(session.orgId, sessionId);
  await putObject(key, wav, "audio/wav");
  await db.interviewSession.update({
    where: { id: sessionId },
    data: { s3AudioKey: key },
  });
  return NextResponse.json({ ok: true, bytes: wav.length });
}

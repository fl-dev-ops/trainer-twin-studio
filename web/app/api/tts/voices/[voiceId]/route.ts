import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionOrg } from "@/lib/org";
import { deletePrefix, getObjectText, presignedGetUrl, voicePrefix } from "@/lib/s3";

/**
 * Voice resolver for the TTS service (server-to-server).
 * Auth: Authorization: Bearer <TTS_APP_KEY> — the shared secret configured
 * in both the web app and the TTS container.
 *
 * Returns presigned audio URL + inline transcript + a version string that
 * changes whenever the reference changes (drives the TTS side's cache).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ voiceId: string }> },
) {
  const expected = process.env.TTS_APP_KEY;
  if (!expected) return NextResponse.json({ error: "TTS_APP_KEY is not configured" }, { status: 500 });
  const token = (request.headers.get("authorization") ?? "").replace("Bearer ", "");
  if (token !== expected) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { voiceId } = await params;
  const voice = await db.voice.findUnique({ where: { id: voiceId } });
  if (!voice || !voice.s3AudioKey) return NextResponse.json({ error: "voice not found" }, { status: 404 });

  const transcript = voice.s3TranscriptKey
    ? ((await getObjectText(voice.s3TranscriptKey).catch(() => "")) || "").trim()
    : "";

  return NextResponse.json({
    id: voice.id,
    name: voice.name,
    version: voice.updatedAt.toISOString(),
    audioUrl: await presignedGetUrl(voice.s3AudioKey, 600),
    transcript: transcript || null,
  });
}

/** Rename a user-cloned voice from the voice library. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ voiceId: string }> },
) {
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const name = String((await request.json()).name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (name.length > 60) return NextResponse.json({ error: "name must be 60 characters or fewer" }, { status: 400 });

  const { voiceId } = await params;
  const voice = await db.voice.findFirst({ where: { id: voiceId, orgId: org.id }, select: { kind: true } });
  if (!voice) return NextResponse.json({ error: "voice not found" }, { status: 404 });
  if (voice.kind !== "cloned") return NextResponse.json({ error: "sample voices cannot be renamed" }, { status: 403 });

  const updated = await db.voice.update({
    where: { id: voiceId },
    data: { name },
    select: { id: true, name: true },
  });
  return NextResponse.json({ voice: updated });
}

/** Delete a cloned voice and its stored reference files. */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ voiceId: string }> },
) {
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { voiceId } = await params;
  const voice = await db.voice.findFirst({ where: { id: voiceId, orgId: org.id }, select: { kind: true } });
  if (!voice) return NextResponse.json({ error: "voice not found" }, { status: 404 });
  if (voice.kind !== "cloned") return NextResponse.json({ error: "sample voices cannot be deleted" }, { status: 403 });

  await deletePrefix(voicePrefix(voiceId));
  await db.voice.delete({ where: { id: voiceId } });
  return new Response(null, { status: 204 });
}

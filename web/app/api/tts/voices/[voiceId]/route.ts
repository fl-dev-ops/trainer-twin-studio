import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { errorResponse, refusals } from "@/lib/errors";
import { studioOrRefusal } from "@/lib/org";
import { getObjectText, presignedGetUrl } from "@/lib/s3";
import { deleteVoice, findAvailableVoice, renameVoice } from "@/lib/voices";

const renameFields = z.strictObject({ name: z.string().trim().min(1).max(60) });

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
  if (request.headers.get("authorization") !== `Bearer ${expected}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { voiceId } = await params;
  // TTS resolves by ID with its server credential, not a browser-supplied organization.
  const identity = await db.voice.findUnique({ where: { id: voiceId }, select: { orgId: true } });
  if (!identity) return NextResponse.json({ error: "voice not found" }, { status: 404 });
  try {
    const voice = await findAvailableVoice(identity.orgId, voiceId);

    const transcript = voice.s3TranscriptKey
      ? ((await getObjectText(voice.s3TranscriptKey)) || "").trim()
      : "";

    return NextResponse.json({
      id: voice.id,
      name: voice.name,
      version: voice.updatedAt.toISOString(),
      audioUrl: await presignedGetUrl(voice.s3AudioKey, 600),
      transcript: transcript || null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Rename a user-cloned voice from the voice library. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ voiceId: string }> },
) {
  const org = await studioOrRefusal();
  if (org instanceof Response) return org;
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch (error) {
      if (error instanceof SyntaxError) throw refusals.invalidInput("A JSON voice name is required.");
      throw error;
    }
    const fields = renameFields.safeParse(body);
    if (!fields.success) throw refusals.invalidInput("name must be between 1 and 60 characters");
    const { voiceId } = await params;
    const voice = await renameVoice(org.id, voiceId, fields.data.name);
    return NextResponse.json({ voice });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Delete a cloned voice and its stored reference files. */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ voiceId: string }> },
) {
  const org = await studioOrRefusal();
  if (org instanceof Response) return org;
  const { voiceId } = await params;
  try {
    await deleteVoice(org.id, voiceId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

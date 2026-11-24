import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { studioOrRefusal } from "@/lib/org";
import { AppError } from "@/lib/errors";
import { PersonaMediaError, setPersonaAvatar, setPersonaVoice, setPersonaVoiceFrom } from "@/lib/persona-media";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Upload a role-play persona's media (multipart): `voiceId` gives it a voice from the voice library, or `audio`
 * (+ optional `transcript`) a recorded one; `image` and/or `video` set its avatar. Studio only.
 * A trainer's avatar is still managed through Twin's brain; voice references are shared.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const org = await studioOrRefusal();
  if (org instanceof Response) return org;
  const slug = (await params).slug;
  const persona = await db.persona.findFirst({ where: { orgId: org.id, slug }, select: { isOwn: true } });
  if (!persona) return NextResponse.json({ error: "Persona not found" }, { status: 404 });

  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Send the files as a form" }, { status: 400 });
  const file = (key: string) => {
    const value = form.get(key);
    return value instanceof File && value.size ? value : undefined;
  };
  const audio = file("audio");
  const image = file("image");
  const video = file("video");
  const voiceId = String(form.get("voiceId") ?? "").trim();
  if (persona.isOwn && (image || video)) return NextResponse.json({ error: "Update your trainer's photo and video from Twin's brain." }, { status: 403 });
  if (voiceId && audio) return NextResponse.json({ error: "Choose a voice or upload a recording, not both." }, { status: 400 });
  if (!audio && !image && !video && !voiceId) return NextResponse.json({ error: "Pick a voice, or add a photo or a video" }, { status: 400 });
  try {
    if (voiceId) await setPersonaVoiceFrom(org.id, slug, voiceId);
    else if (audio) {
      const name = String(form.get("voiceName") ?? "").trim();
      if (!name) return NextResponse.json({ error: "Name the voice: it joins your voice library under that name." }, { status: 400 });
      await setPersonaVoice(org.id, slug, { name, audio, transcript: String(form.get("transcript") ?? "") });
    }
    if (image || video) await setPersonaAvatar(org.id, slug, { image, video });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AppError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    if (error instanceof PersonaMediaError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getTrainerOrg } from "@/lib/org";
import { PersonaMediaError, setPersonaAvatar, setPersonaVoice } from "@/lib/persona-media";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Upload a role-play persona's media (multipart): `audio` (+ optional `transcript`) sets its voice; `image` and/or
 * `video` set its avatar. Studio only. A trainer's own persona is set up on Twin's brain instead.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const org = await getTrainerOrg();
  if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const slug = (await params).slug;
  const persona = await db.persona.findFirst({ where: { orgId: org.id, slug }, select: { isOwn: true } });
  if (!persona || persona.isOwn) return NextResponse.json({ error: "Persona not found" }, { status: 404 });

  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Send the files as a form" }, { status: 400 });
  const file = (key: string) => {
    const value = form.get(key);
    return value instanceof File && value.size ? value : undefined;
  };
  const audio = file("audio");
  const image = file("image");
  const video = file("video");
  if (!audio && !image && !video) return NextResponse.json({ error: "Add a voice sample, a photo or a video" }, { status: 400 });
  try {
    if (audio) await setPersonaVoice(org.id, slug, { audio, transcript: String(form.get("transcript") ?? "") });
    if (image || video) await setPersonaAvatar(org.id, slug, { image, video });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof PersonaMediaError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

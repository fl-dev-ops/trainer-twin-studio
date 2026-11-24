import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, refusals } from "@/lib/errors";
import { studioOrRefusal } from "@/lib/org";
import { voiceDetailsSchema } from "@/lib/voice-details";
import { createVoice, listAvailableVoices } from "@/lib/voices";

const uploadFields = voiceDetailsSchema.extend({
  name: z.string().trim().max(60),
  transcript: z.string().trim().max(5000),
});
/** A form field, or undefined when it isn't sent (an empty one clears nothing on a new voice). */
const formText = (form: FormData, key: string) => { const value = form.get(key); return typeof value === "string" && value.trim() ? value.trim() : undefined; };

/** List trainer voices. */
export async function GET() {
  const org = await studioOrRefusal();
  if (org instanceof Response) return org;
  const voices = await listAvailableVoices(org.id);
  return NextResponse.json({ voices: voices.map((voice) => ({
    id: voice.id, name: voice.name, kind: voice.kind, status: voice.status, language: voice.language, gender: voice.gender, age: voice.age, accent: voice.accent,
    createdAt: voice.createdAt.toISOString(), updatedAt: voice.updatedAt.toISOString(),
  })) });
}

/** Upload a new trainer voice: reference audio + optional transcript. */
export async function POST(request: NextRequest) {
  const org = await studioOrRefusal();
  if (org instanceof Response) return org;
  try {
    let form: FormData;
    try {
      form = await request.formData();
    } catch (error) {
      if (error instanceof TypeError) throw refusals.invalidInput("A multipart voice upload is required.");
      throw error;
    }
    const audio = form.get("audio");
    if (!(audio instanceof File)) throw refusals.invalidInput("audio file is required");
    const fields = uploadFields.safeParse({
      name: form.get("name") ?? "",
      transcript: form.get("transcript") ?? "",
      language: formText(form, "language"), gender: formText(form, "gender"), age: formText(form, "age"), accent: formText(form, "accent"),
    });
    if (!fields.success) throw refusals.invalidInput("Use a name up to 60 characters, a transcript up to 5,000 characters, gender female or male, age young, middle-aged or older, and an accent up to 40 characters.");
    const voice = await createVoice(org.id, {
      name: fields.data.name || "Untitled voice",
      audio,
      transcript: fields.data.transcript || undefined,
      details: { language: fields.data.language, gender: fields.data.gender, age: fields.data.age, accent: fields.data.accent },
    });
    return NextResponse.json({ voice: { id: voice.id, name: voice.name, status: voice.status } });
  } catch (error) {
    return errorResponse(error);
  }
}

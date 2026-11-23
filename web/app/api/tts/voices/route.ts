import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, refusals } from "@/lib/errors";
import { studioOrRefusal } from "@/lib/org";
import { createVoice, listAvailableVoices } from "@/lib/voices";

const uploadFields = z.object({
  name: z.string().trim().max(60),
  transcript: z.string().trim().max(5000),
});

/** List trainer voices. */
export async function GET() {
  const org = await studioOrRefusal();
  if (org instanceof Response) return org;
  const voices = await listAvailableVoices(org.id);
  return NextResponse.json({ voices: voices.map((voice) => ({
    id: voice.id, name: voice.name, kind: voice.kind, status: voice.status,
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
    });
    if (!fields.success) throw refusals.invalidInput("Use a name up to 60 characters and a transcript up to 5,000 characters.");
    const voice = await createVoice(org.id, {
      name: fields.data.name || "Untitled voice",
      audio,
      transcript: fields.data.transcript || undefined,
    });
    return NextResponse.json({ voice: { id: voice.id, name: voice.name, status: voice.status } });
  } catch (error) {
    return errorResponse(error);
  }
}

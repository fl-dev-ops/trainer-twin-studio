import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getTrainerOrg } from "@/lib/org";
import { putObject, s3Configured } from "@/lib/s3";
import { personaPhotoKey, personaPhotoUrl, PERSONA_PHOTO_TYPES, MAX_PERSONA_PHOTO_BYTES } from "@/lib/client-persona-photo";

export const runtime = "nodejs";

/** Upload a photo for a client persona made from scratch. Returns the URL to store as the persona's avatar. */
export async function POST(request: Request) {
  const org = await getTrainerOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!s3Configured) return NextResponse.json({ error: "Photo storage is not configured" }, { status: 500 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose a photo to upload" }, { status: 400 });
  const ext = PERSONA_PHOTO_TYPES[file.type];
  if (!ext) return NextResponse.json({ error: "Use a JPG, PNG or WebP photo" }, { status: 400 });
  if (file.size > MAX_PERSONA_PHOTO_BYTES) return NextResponse.json({ error: "Photos must be 5 MB or smaller" }, { status: 400 });

  const name = `${randomUUID()}.${ext}`;
  await putObject(personaPhotoKey(org.id, name), new Uint8Array(await file.arrayBuffer()), file.type);
  return NextResponse.json({ url: personaPhotoUrl(org.id, name) }, { status: 201 });
}

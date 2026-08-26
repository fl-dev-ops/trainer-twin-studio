import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionOrg } from "@/lib/org";
import { putObject, voicePrefix } from "@/lib/s3";

/** List trainer voices. */
export async function GET() {
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const voices = await db.voice.findMany({
    where: { OR: [{ orgId: org.id }, { orgId: null }] },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, kind: true, status: true, createdAt: true, updatedAt: true },
  });
  return NextResponse.json({ voices: voices.map((v) => ({ ...v, createdAt: v.createdAt.toISOString(), updatedAt: v.updatedAt.toISOString() })) });
}

/** Upload a new trainer voice: reference audio + optional transcript. */
export async function POST(request: NextRequest) {
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!s3Configured()) return NextResponse.json({ error: "S3 is not configured" }, { status: 500 });

  const form = await request.formData();
  const audio = form.get("audio");
  const requestedName = String(form.get("name") ?? "").trim();
  const transcript = String(form.get("transcript") ?? "").trim();

  if (!(audio instanceof File) || audio.size === 0) {
    return NextResponse.json({ error: "audio file is required" }, { status: 400 });
  }
  if (audio.size > 25 * 1024 * 1024) {
    return NextResponse.json({ error: "audio must be under 25 MB" }, { status: 400 });
  }

  const name = requestedName || `Untitled ${await db.voice.count({ where: { kind: "cloned" } }) + 1}`;
  const voice = await db.voice.create({
    data: { orgId: org.id, name, s3AudioKey: "" },
  });

  const prefix = voicePrefix(voice.id);
  const bytes = new Uint8Array(await audio.arrayBuffer());
  await putObject(`${prefix}/reference.wav`, bytes, audio.type || "audio/wav");

  let transcriptKey: string | null = null;
  if (transcript) {
    transcriptKey = `${prefix}/transcript.txt`;
    await putObject(transcriptKey, transcript, "text/plain");
  }

  const updated = await db.voice.update({
    where: { id: voice.id },
    data: { s3AudioKey: `${prefix}/reference.wav`, s3TranscriptKey: transcriptKey },
    select: { id: true, name: true, status: true },
  });
  return NextResponse.json({ voice: updated });
}

function s3Configured() {
  return Boolean(process.env.S3_BUCKET?.trim() && process.env.AWS_ACCESS_KEY_ID);
}

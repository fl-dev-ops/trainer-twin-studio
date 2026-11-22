import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { errorResponse, refusals } from "@/lib/errors";
import { studioOrRefusal } from "@/lib/org";
import { findAvailableVoice } from "@/lib/voices";

const speechFields = z.strictObject({
  voice: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  input: z.string().trim().min(1).max(5000),
  stream: z.boolean().default(true),
  response_format: z.enum(["pcm", "wav"]).default("pcm"),
  model: z.literal("voxcpm2").optional(),
});

/**
 * Browser-facing proxy to the TTS service. Streams audio straight through so
 * the TTS_API_KEY never reaches the client and no CORS setup is needed.
 */
export async function POST(request: NextRequest) {
  const key = process.env.TTS_SERVICE_KEY;
  let orgId: string | null = null;
  if (!key || request.headers.get("authorization") !== `Bearer ${key}`) {
    const org = await studioOrRefusal();
    if (org instanceof Response) return org;
    orgId = org.id;
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    if (error instanceof SyntaxError) return errorResponse(refusals.invalidInput("A JSON speech request is required."));
    throw error;
  }
  const fields = speechFields.safeParse(body);
  if (!fields.success) return errorResponse(refusals.invalidInput("Use an available voice and 1–5,000 characters of text, with PCM or WAV output."));
  const speech = fields.data;
  // The voice-agent bridge is a trusted server client; browser previews must remain scoped to their org.
  const identity = orgId === null
    ? await db.voice.findUnique({ where: { id: speech.voice }, select: { orgId: true } })
    : { orgId };
  if (!identity) return NextResponse.json({ error: "voice not found" }, { status: 404 });
  const voice = await findAvailableVoice(identity.orgId, speech.voice).catch((error: unknown) => errorResponse(error));
  if (voice instanceof Response) return voice;
  const serviceUrl = process.env.TTS_SERVICE_URL;
  if (!serviceUrl) {
    return NextResponse.json({ error: "TTS_SERVICE_URL is not configured" }, { status: 500 });
  }

  const upstream = await fetch(`${serviceUrl.replace(/\/$/, "")}/v1/audio/speech`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.TTS_SERVICE_KEY ? { Authorization: `Bearer ${process.env.TTS_SERVICE_KEY}` } : {}),
    },
    body: JSON.stringify({ model: "voxcpm2", voice: voice.id, input: speech.input, stream: speech.stream, response_format: speech.response_format }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text();
    return NextResponse.json({ error: detail || `TTS service returned ${upstream.status}` }, { status: upstream.ok ? 502 : upstream.status });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "audio/pcm",
      "X-Sample-Rate": upstream.headers.get("X-Sample-Rate") ?? "24000",
      "Cache-Control": "no-store",
    },
  });
}

import { NextRequest, NextResponse } from "next/server";

/**
 * Browser-facing proxy to the TTS service. Streams audio straight through so
 * the TTS_API_KEY never reaches the client and no CORS setup is needed.
 */
export async function POST(request: NextRequest) {
  const serviceUrl = process.env.TTS_SERVICE_URL;
  if (!serviceUrl) return NextResponse.json({ error: "TTS_SERVICE_URL is not configured" }, { status: 500 });

  const body = await request.json();
  const upstream = await fetch(`${serviceUrl.replace(/\/$/, "")}/v1/audio/speech`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.TTS_SERVICE_KEY ? { Authorization: `Bearer ${process.env.TTS_SERVICE_KEY}` } : {}),
    },
    body: JSON.stringify({ model: "voxcpm2", response_format: "pcm", stream: true, ...body }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return NextResponse.json({ error: detail || `TTS service returned ${upstream.status}` }, { status: upstream.status });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "audio/pcm",
      "X-Sample-Rate": upstream.headers.get("X-Sample-Rate") ?? "24000",
      "Cache-Control": "no-store",
    },
  });
}

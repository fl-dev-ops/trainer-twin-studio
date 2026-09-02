import { NextResponse } from "next/server";
import { disconnectYouTube, listYouTubeImports, previewYouTubeImport, queueYouTubeSync } from "@/lib/youtube-ingestion";
import { youtubeRequestSchema, youtubeDisconnectSchema } from "@/lib/youtube";
import { resolveSessionUser } from "@/lib/session-user";
import { dashboardUrl } from "@/lib/dashboard-url.server";
import { YouTubeError } from "../../../../../../shared/youtube/types";

export const runtime = "nodejs";

type Params = { params: Promise<{ kb: string }> };

async function readInput(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8192) { await reader.cancel(); return null; }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch { return null; }
}

export async function GET(_request: Request, { params }: Params) {
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { kb } = await params;
  try {
    return NextResponse.json(await listYouTubeImports(org.id, user.id, kb));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof YouTubeError ? error.message : "Could not list YouTube imports" },
      { status: 404 },
    );
  }
}

export async function POST(request: Request, { params }: Params) {
  if (request.headers.get("origin") !== dashboardUrl("/").origin) return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (Number(request.headers.get("content-length") ?? 0) > 8192) return NextResponse.json({ error: "Request too large" }, { status: 413 });
  const parsed = youtubeRequestSchema.safeParse(await readInput(request));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || "Invalid YouTube URL" }, { status: 400 });
  const { kb } = await params;
  try {
    const { action, ...input } = parsed.data;
    const result = await (action === "preview" ? previewYouTubeImport : queueYouTubeSync)({
      orgId: org.id,
      userId: user.id,
      kbSlug: kb,
      ...input,
    });
    return NextResponse.json(result, { status: action === "preview" ? 200 : 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof YouTubeError ? error.message : "Could not process YouTube import", code: error instanceof YouTubeError ? error.code : "IMPORT_FAILED" },
      { status: error instanceof YouTubeError && error.retryable ? 503 : 400 },
    );
  }
}

export async function DELETE(request: Request, { params }: Params) {
  if (request.headers.get("origin") !== dashboardUrl("/").origin) return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = youtubeDisconnectSchema.safeParse(await readInput(request));
  if (!parsed.success) return NextResponse.json({ error: "Invalid connection" }, { status: 400 });
  try {
    const { kb } = await params;
    return NextResponse.json(await disconnectYouTube(org.id, user.id, kb, parsed.data.connectionId), { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof YouTubeError ? error.message : "Could not disconnect YouTube" }, { status: 400 });
  }
}

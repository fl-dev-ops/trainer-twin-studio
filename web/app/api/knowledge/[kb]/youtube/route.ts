import { NextResponse } from "next/server";
import { getTrainerOrg } from "@/lib/org";
import {
  previewYouTubeImport,
  queueYouTubeSync,
  refreshYouTubeDocument,
} from "@/lib/youtube-ingestion";
import { youtubeRequestSchema } from "@/lib/youtube";
import { YouTubeError } from "../../../../../../shared/youtube/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ kb: string }> };

export async function POST(request: Request, { params }: Params) {
  const trainer = await getTrainerOrg();
  if (!trainer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { kb } = await params;
  try {
    const json = await request.json().catch(() => null);
    const parsed = youtubeRequestSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid YouTube request payload", details: parsed.error.format() },
        { status: 400 },
      );
    }

    if (parsed.data.action === "refresh-document") {
      const result = await refreshYouTubeDocument({
        orgId: trainer.id,
        userId: trainer.user.id,
        kbSlug: kb,
        documentId: parsed.data.documentId,
      });
      return NextResponse.json(result, { status: 202 });
    }

    const { action, ...input } = parsed.data;
    if (action === "preview") {
      const preview = await previewYouTubeImport({
        orgId: trainer.id,
        userId: trainer.user.id,
        kbSlug: kb,
        ...input,
      });
      return NextResponse.json(preview);
    }

    const result = await queueYouTubeSync({
      orgId: trainer.id,
      userId: trainer.user.id,
      kbSlug: kb,
      ...input,
    });
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    console.error(`[API:knowledge:${kb}:youtube:post] failed:`, error);
    return NextResponse.json(
      {
        error: error instanceof YouTubeError ? error.message : (error instanceof Error ? error.message : "Could not process YouTube import"),
        code: error instanceof YouTubeError ? error.code : "IMPORT_FAILED",
      },
      { status: error instanceof YouTubeError && error.retryable ? 503 : 400 },
    );
  }
}

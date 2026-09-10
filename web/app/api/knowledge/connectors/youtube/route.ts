import { NextResponse } from "next/server";
import { getTrainerOrg } from "@/lib/org";
import { youtubeImportSchema } from "@/lib/youtube";
import { queueYouTubeSync } from "@/lib/youtube-ingestion";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const trainer = await getTrainerOrg();
  if (!trainer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const json = await request.json();
    const parsed = youtubeImportSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request payload", details: parsed.error.format() },
        { status: 400 },
      );
    }

    const result = await queueYouTubeSync({
      orgId: trainer.id,
      userId: trainer.user.id,
      ...parsed.data,
    });

    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    console.error("[API:connectors:youtube] failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to import YouTube content" },
      { status: 500 },
    );
  }
}

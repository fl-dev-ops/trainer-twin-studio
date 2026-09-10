import { NextResponse } from "next/server";
import { getTrainerOrg } from "@/lib/org";
import { startYouTubeOAuth } from "@/lib/youtube-oauth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const trainer = await getTrainerOrg();
  if (!trainer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json().catch(() => ({}));
    const kbId = body.kbId || body.kbSlug;

    const url = await startYouTubeOAuth(trainer.id, trainer.user.id, kbId);
    return NextResponse.json({ url });
  } catch (error) {
    console.error("[API:youtube:oauth:start] failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start YouTube OAuth" },
      { status: 500 },
    );
  }
}

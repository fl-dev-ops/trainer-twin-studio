import { NextResponse } from "next/server";
import { resolveSessionUser } from "@/lib/session-user";
import { startYouTubeOAuth } from "@/lib/youtube-oauth";
import { YouTubeError } from "../../../../../../shared/youtube/types";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const kb = new URL(request.url).searchParams.get("kb");
  if (!kb) return NextResponse.json({ error: "Missing knowledge base" }, { status: 400 });
  try {
    return NextResponse.redirect(await startYouTubeOAuth(org.id, user.id, kb));
  } catch (error) {
    return NextResponse.json({ error: error instanceof YouTubeError ? error.message : "Could not start YouTube connection" }, { status: 400 });
  }
}

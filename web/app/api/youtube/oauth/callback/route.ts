import { NextResponse } from "next/server";
import { resolveSessionUser } from "@/lib/session-user";
import { finishYouTubeOAuth } from "@/lib/youtube-oauth";
import { dashboardUrl } from "@/lib/dashboard-url.server";
import { YouTubeError } from "../../../../../../shared/youtube/types";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const callback = new URL(request.url);
  // Google accepts localhost, but the app session cookie lives on our HTTPS subdomain.
  if (
    process.env.NODE_ENV === "development" &&
    request.headers.get("host") === "localhost:3000" &&
    process.env.YOUTUBE_OAUTH_REDIRECT_URI === "http://localhost:3000/api/youtube/oauth/callback"
  ) {
    const destination = dashboardUrl("/api/youtube/oauth/callback");
    for (const key of ["code", "state", "error"]) {
      const value = callback.searchParams.get(key);
      if (value !== null) destination.searchParams.set(key, value);
    }
    // Fixed destination only; session, one-use state and PKCE are checked on arrival.
    return NextResponse.redirect(destination, {
      status: 303,
      headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  }
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const result = await finishYouTubeOAuth(org.id, user.id, callback.searchParams);
    const url = dashboardUrl(`/knowledge/${encodeURIComponent(result.kbSlug)}`);
    url.searchParams.set("youtube", result.status);
    return NextResponse.redirect(url);
  } catch (error) {
    const url = dashboardUrl("/knowledge");
    url.searchParams.set("youtube", "error");
    console.error(`[EXT-API:youtube-oauth] failed code=${error instanceof YouTubeError ? error.code : "CALLBACK_FAILED"}`);
    return NextResponse.redirect(url);
  }
}

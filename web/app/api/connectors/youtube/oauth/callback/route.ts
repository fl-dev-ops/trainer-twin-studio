import { NextResponse } from "next/server";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { getTrainerOrg } from "@/lib/org";
import { finishYouTubeOAuth } from "@/lib/youtube-oauth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const trainer = await getTrainerOrg();
  const url = new URL(request.url);
  const stateParam = url.searchParams.get("state") ?? "";
  const isOnboarding = stateParam.startsWith("onb_");
  const hostHeader =
    request.headers.get("x-forwarded-host") ||
    request.headers.get("host") ||
    "";
  const port = hostHeader.includes(":") ? `:${hostHeader.split(":")[1]}` : "";

  const redirectBase = isOnboarding
    ? new URL(`https://auth.${BASE_DOMAIN}${port}/onboarding`)
    : new URL("/knowledge", url.origin);

  if (isOnboarding) {
    redirectBase.searchParams.set("step", "3");
  }

  if (!trainer) {
    redirectBase.searchParams.set("error", "unauthorized");
    return NextResponse.redirect(redirectBase);
  }

  try {
    const result = await finishYouTubeOAuth(
      trainer.id,
      trainer.user.id,
      url.searchParams,
    );
    if (result.status === "cancelled") {
      redirectBase.searchParams.set("error", "cancelled");
      return NextResponse.redirect(redirectBase);
    }

    redirectBase.searchParams.set("connector", "youtube");
    redirectBase.searchParams.set("connected", "true");
    return NextResponse.redirect(redirectBase);
  } catch (error) {
    console.error("[API:youtube:oauth:callback] failed:", error);
    redirectBase.searchParams.set(
      "error",
      error instanceof Error ? error.message : "oauth_failed",
    );
    return NextResponse.redirect(redirectBase);
  }
}

import { NextResponse } from "next/server";
import { getTrainerOrg } from "@/lib/org";
import { consumeNotionOAuthState, exchangeNotionCode, saveNotionConnection } from "@/lib/notion-oauth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const trainer = await getTrainerOrg();
  const url = new URL(request.url);
  const redirectBase = new URL("/knowledge", url.origin);

  if (!trainer) {
    redirectBase.searchParams.set("error", "unauthorized");
    return NextResponse.redirect(redirectBase);
  }

  const stateParam = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    redirectBase.searchParams.set("error", oauthError);
    return NextResponse.redirect(redirectBase);
  }

  if (!stateParam || !code) {
    redirectBase.searchParams.set("error", "missing_oauth_params");
    return NextResponse.redirect(redirectBase);
  }

  try {
    const state = await consumeNotionOAuthState(stateParam, trainer.id, trainer.user.id);
    if (!state || state.orgId !== trainer.id) {
      redirectBase.searchParams.set("error", "invalid_or_expired_state");
      return NextResponse.redirect(redirectBase);
    }

    const token = await exchangeNotionCode(code);
    await saveNotionConnection(trainer.id, trainer.user.id, token);

    redirectBase.searchParams.set("connector", "notion");
    redirectBase.searchParams.set("connected", "true");
    return NextResponse.redirect(redirectBase);
  } catch (error) {
    console.error("[API:notion:oauth:callback] failed:", error);
    redirectBase.searchParams.set(
      "error",
      error instanceof Error ? error.message : "oauth_failed",
    );
    return NextResponse.redirect(redirectBase);
  }
}

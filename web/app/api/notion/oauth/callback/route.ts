import { NextResponse } from "next/server";
import {
  consumeNotionOAuthState,
  exchangeNotionCode,
  saveNotionConnection,
} from "@/lib/notion-oauth";
import { db } from "@/lib/db";
import { dashboardUrl } from "@/lib/dashboard-url.server";
import { resolveSessionUser } from "@/lib/session-user";
export const runtime = "nodejs";

function redirectToKnowledge(kbSlug?: string, status = "error") {
  const path = kbSlug
    ? `/dash/knowledge/${encodeURIComponent(kbSlug)}`
    : "/dash/knowledge";
  const url = dashboardUrl(path);
  url.searchParams.set("notion", status);
  return NextResponse.redirect(url);
}

/** Completes Notion OAuth and stores encrypted workspace credentials. */
export async function GET(request: Request) {
  const callback = new URL(request.url);
  if (
    process.env.NODE_ENV === "development" &&
    request.headers.get("host")?.includes("localhost:3000")
  ) {
    const destination = dashboardUrl("/api/notion/oauth/callback");
    for (const key of ["code", "state", "error"]) {
      const value = callback.searchParams.get(key);
      if (value !== null) destination.searchParams.set(key, value);
    }
    return NextResponse.redirect(destination, {
      status: 303,
      headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  }
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const params = callback.searchParams;
  const stateId = params.get("state");
  if (!stateId) return redirectToKnowledge();
  const state = await consumeNotionOAuthState(stateId, org.id, user.id);
  if (!state) return redirectToKnowledge();

  const kb = await db.knowledgeBase.findFirst({
    where: { id: state.kbId, orgId: org.id },
    select: { slug: true },
  });
  if (!kb) return redirectToKnowledge();
  if (params.get("error")) return redirectToKnowledge(kb.slug, "cancelled");
  const code = params.get("code");
  if (!code) return redirectToKnowledge(kb.slug);
  try {
    const token = await exchangeNotionCode(code);
    await saveNotionConnection(org.id, user.id, token);
    return redirectToKnowledge(kb.slug, "connected");
  } catch (error) {
    console.error("[EXT-API:notion-oauth] callback failed:", error);
    return redirectToKnowledge(kb.slug);
  }
}

import { NextResponse } from "next/server";
import {
  consumeNotionOAuthState,
  exchangeNotionCode,
  saveNotionConnection,
} from "@/lib/notion-oauth";
import { db } from "@/lib/db";
import { resolveSessionUser } from "@/lib/session-user";

export const runtime = "nodejs";

function redirectToKnowledge(request: Request, kbSlug?: string, status = "error") {
  const path = kbSlug
    ? `/dash/knowledge/${encodeURIComponent(kbSlug)}`
    : "/dash/knowledge";
  const url = new URL(path, request.url);
  url.searchParams.set("notion", status);
  return NextResponse.redirect(url);
}

/** Completes Notion OAuth and stores encrypted workspace credentials. */
export async function GET(request: Request) {
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const stateId = params.get("state");
  if (!stateId) return redirectToKnowledge(request);
  const state = await consumeNotionOAuthState(stateId, org.id, user.id);
  if (!state) return redirectToKnowledge(request);

  const kb = await db.knowledgeBase.findFirst({
    where: { id: state.kbId, orgId: org.id },
    select: { slug: true },
  });
  if (!kb) return redirectToKnowledge(request);
  if (params.get("error")) return redirectToKnowledge(request, kb.slug, "cancelled");
  const code = params.get("code");
  if (!code) return redirectToKnowledge(request, kb.slug);

  try {
    const token = await exchangeNotionCode(code);
    await saveNotionConnection(org.id, user.id, token);
    return redirectToKnowledge(request, kb.slug, "connected");
  } catch {
    return redirectToKnowledge(request, kb.slug);
  }
}

import { NextResponse } from "next/server";
import { createNotionOAuthState, notionAuthorizationUrl } from "@/lib/notion-oauth";
import { db } from "@/lib/db";
import { resolveSessionUser } from "@/lib/session-user";

export const runtime = "nodejs";

/** Starts public Notion OAuth for a knowledge base owned by the trainer's organization. */
export async function GET(request: Request) {
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const kbSlug = new URL(request.url).searchParams.get("kb")?.trim();
  if (!kbSlug) return NextResponse.json({ error: "Missing knowledge base" }, { status: 400 });
  const kb = await db.knowledgeBase.findFirst({
    where: { slug: kbSlug, orgId: org.id },
    select: { id: true },
  });
  if (!kb) return NextResponse.json({ error: "Knowledge base not found" }, { status: 404 });

  try {
    const state = await createNotionOAuthState(org.id, user.id, kb.id);
    return NextResponse.redirect(notionAuthorizationUrl(state));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not start Notion OAuth" },
      { status: 500 },
    );
  }
}

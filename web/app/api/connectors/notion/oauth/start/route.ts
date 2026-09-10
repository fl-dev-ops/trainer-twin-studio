import { NextResponse } from "next/server";
import { getTrainerOrg } from "@/lib/org";
import { createNotionOAuthState, notionAuthorizationUrl } from "@/lib/notion-oauth";
import { getOrCreateOrgKnowledgeBase } from "@/lib/org-knowledge";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const trainer = await getTrainerOrg();
  if (!trainer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json().catch(() => ({}));
    let kbId = body.kbId;

    if (!kbId && body.kbSlug) {
      const kb = await db.knowledgeBase.findFirst({
        where: { slug: body.kbSlug, orgId: trainer.id },
        select: { id: true },
      });
      if (kb) kbId = kb.id;
    }

    if (!kbId) {
      const defaultKb = await getOrCreateOrgKnowledgeBase(trainer.id);
      kbId = defaultKb.id;
    }

    const state = await createNotionOAuthState(trainer.id, trainer.user.id, kbId);
    const url = notionAuthorizationUrl(state);

    return NextResponse.json({ url });
  } catch (error) {
    console.error("[API:notion:oauth:start] failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start Notion OAuth" },
      { status: 500 },
    );
  }
}

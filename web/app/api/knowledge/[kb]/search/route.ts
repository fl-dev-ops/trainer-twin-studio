import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { searchKnowledge } from "@/lib/knowledge";
import { getSessionOrg } from "@/lib/org";

/** Authenticated Studio search; live agents use the session-scoped search API. */
export async function GET(req: Request, { params }: { params: Promise<{ kb: string }> }) {
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { kb } = await params;
  const knowledgeBase = await db.knowledgeBase.findFirst({
    where: { orgId: org.id, slug: kb },
    select: { id: true },
  });
  if (!knowledgeBase) return NextResponse.json({ error: "Knowledge base not found" }, { status: 404 });
  const url = new URL(req.url);
  const query = url.searchParams.get("q");
  if (!query?.trim()) return NextResponse.json({ error: "Missing q" }, { status: 400 });
  const limit = Math.min(Number(url.searchParams.get("k") ?? 3) || 3, 20);
  try {
    const hits = await searchKnowledge(knowledgeBase.id, query, limit);
    return NextResponse.json({
      hits: hits.map((hit) => ({
        text: hit.text,
        source: hit.source,
        score: hit.score,
        distance: 1 - hit.score,
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Search failed",
      hits: [],
    });
  }
}

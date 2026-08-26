import { NextResponse } from "next/server";
import { searchKnowledge } from "@/lib/knowledge";

/** Hybrid knowledge retrieval used by the voice agent at session time. */
export async function GET(req: Request, { params }: { params: Promise<{ kb: string }> }) {
  const { kb } = await params;
  const url = new URL(req.url);
  const q = url.searchParams.get("q");
  if (!q?.trim()) return NextResponse.json({ error: "Missing q" }, { status: 400 });
  const limit = Math.min(Number(url.searchParams.get("k") ?? 3) || 3, 20);
  try {
    const hits = await searchKnowledge(kb, q, limit);
    return NextResponse.json(
      {
        hits: hits.map((h) => ({
          text: h.text,
          source: h.source,
          score: h.score,
          // POC Runtime sorts by distance ascending; map relevance to distance
          distance: 1 - h.score,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Search failed", hits: [] },
      { status: 200 },
    );
  }
}

import { NextResponse } from "next/server";
import { searchKnowledge, topicFilterSchema } from "@/lib/knowledge";
import { z } from "zod";

/** Hybrid knowledge retrieval used by the voice agent at session time. */
export async function GET(req: Request, { params }: { params: Promise<{ kb: string }> }) {
  const { kb } = await params;
  const url = new URL(req.url);
  const q = url.searchParams.get("q");
  if (!q?.trim()) return NextResponse.json({ error: "Missing q" }, { status: 400 });
  const requestedLimit = z.coerce.number().int().positive().safeParse(url.searchParams.get("k") ?? 3);
  const filter = topicFilterSchema.safeParse(url.searchParams.getAll("topic"));
  if (!requestedLimit.success || !filter.success) {
    return NextResponse.json({ error: "Expected a positive integer k and canonical topic slugs" }, { status: 400 });
  }
  const limit = Math.min(requestedLimit.data, 20);
  try {
    const hits = await searchKnowledge(kb, q, limit, { topicFilter: filter.data });
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

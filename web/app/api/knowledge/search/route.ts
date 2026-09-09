import { NextResponse } from "next/server";
import { MainCollectionService } from "@/lib/main-collection";
import { getSessionOrg } from "@/lib/org";

export async function GET(request: Request) {
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const query = new URL(request.url).searchParams.get("q")?.trim();
  if (!query) return NextResponse.json({ error: "Missing q" }, { status: 400 });

  try {
    const hits = await MainCollectionService.searchKnowledge(org.id, query, { limit: 20 });
    return NextResponse.json({ hits }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Search failed" },
      { status: 500 },
    );
  }
}

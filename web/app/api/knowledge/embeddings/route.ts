import { NextResponse } from "next/server";
import { getSessionOrg } from "@/lib/org";
import { OrganizationKnowledgeService } from "@/lib/org-knowledge";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { searchParams } = new URL(req.url);
    const limitParam = searchParams.get("limit");
    const forceRefresh = searchParams.get("refresh") === "true";
    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 1000, 50), 3000) : 2000;

    const data = await OrganizationKnowledgeService.get3DPoints(org.id, limit, forceRefresh);
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": forceRefresh
          ? "no-cache"
          : "private, max-age=120, stale-while-revalidate=600",
      },
    });
  } catch (error) {
    console.error("Failed to load embeddings:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load embeddings" },
      { status: 500 },
    );
  }
}

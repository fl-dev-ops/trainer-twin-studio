import { NextResponse } from "next/server";
import { getSessionOrg } from "@/lib/org";
import { OrganizationKnowledgeService } from "@/lib/org-knowledge";

export async function GET() {
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const stats = await OrganizationKnowledgeService.getStats(org.id);
    return NextResponse.json(stats);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load stats" },
      { status: 500 },
    );
  }
}

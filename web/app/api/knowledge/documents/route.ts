import { NextResponse } from "next/server";
import { getSessionOrg } from "@/lib/org";
import { OrganizationKnowledgeService } from "@/lib/org-knowledge";

export const dynamic = "force-dynamic";

export async function GET() {
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const documents = await OrganizationKnowledgeService.getAllDocuments(org.id);
    return NextResponse.json({ documents });
  } catch (error) {
    console.error("Failed to fetch documents:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch documents" },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";
import { studioOrRefusal } from "@/lib/org";
import { OrganizationKnowledgeService } from "@/lib/org-knowledge";

export const dynamic = "force-dynamic";

export async function GET() {
  const org = await studioOrRefusal();
  if (org instanceof Response) return org;

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

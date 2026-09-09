import { NextResponse } from "next/server";
import { getSessionOrg } from "@/lib/org";
import { OrganizationKnowledgeService } from "@/lib/org-knowledge";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Document ID required" }, { status: 400 });

  try {
    const chunks = await OrganizationKnowledgeService.getDocumentChunks(org.id, id);
    return NextResponse.json({ chunks });
  } catch (error) {
    console.error("Failed to load chunks:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load chunks" },
      { status: 500 },
    );
  }
}

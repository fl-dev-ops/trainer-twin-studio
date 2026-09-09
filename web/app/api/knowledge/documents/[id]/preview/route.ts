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
    const url = await OrganizationKnowledgeService.getPreviewUrl(org.id, id);
    if (!url) return NextResponse.json({ error: "Preview not available" }, { status: 404 });
    return NextResponse.json({ url });
  } catch (error) {
    console.error("Failed to generate preview url:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load preview" },
      { status: 500 },
    );
  }
}

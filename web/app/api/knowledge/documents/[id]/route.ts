import { NextResponse } from "next/server";
import { getSessionOrg } from "@/lib/org";
import { OrganizationKnowledgeService } from "@/lib/org-knowledge";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, { params }: Params) {
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Document ID required" }, { status: 400 });

  try {
    await OrganizationKnowledgeService.deleteDocument(org.id, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Failed to delete document:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete document" },
      { status: 500 },
    );
  }
}

export async function POST(_req: Request, { params }: Params) {
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Document ID required" }, { status: 400 });

  try {
    const chunkCount = await OrganizationKnowledgeService.reindexDocument(org.id, id);
    return NextResponse.json({ ok: true, chunkCount });
  } catch (error) {
    console.error("Failed to reindex document:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to reindex document" },
      { status: 500 },
    );
  }
}

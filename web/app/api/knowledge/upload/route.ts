import { NextResponse } from "next/server";
import { studioOrRefusal } from "@/lib/org";
import { OrganizationKnowledgeService } from "@/lib/org-knowledge";

export async function POST(req: Request) {
  const trainer = await studioOrRefusal();
  if (trainer instanceof Response) return trainer;

  try {
    const formData = await req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const doc = await OrganizationKnowledgeService.uploadDocument(trainer.id, file);
    return NextResponse.json(
      { ok: true, status: doc.status, document: doc, jobId: doc.jobId },
      { status: 201 },
    );
  } catch (error) {
    console.error("Upload failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 500 },
    );
  }
}

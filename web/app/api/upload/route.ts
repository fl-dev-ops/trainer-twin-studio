import { NextResponse } from "next/server";
import { getSessionOrg } from "@/lib/org";
import { listUploads, saveUpload } from "@/lib/specs";

export async function GET() {
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const files = await listUploads(org.id);
  return NextResponse.json({
    files: files.map((f) => ({ id: f.id, name: f.name, size: f.size, createdAt: f.createdAt })),
  });
}

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const doc = await saveUpload(org.id, file.name, file.type || "application/octet-stream", Buffer.from(await file.arrayBuffer()));
    return NextResponse.json({ ok: true, id: doc.id, name: doc.name });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 400 },
    );
  }
}

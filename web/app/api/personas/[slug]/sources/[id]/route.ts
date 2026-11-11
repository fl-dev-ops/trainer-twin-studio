import { NextResponse } from "next/server";
import { studioOrRefusal } from "@/lib/org";
import { deletePersonaSource } from "@/lib/persona-synthesis";

type Params = { params: Promise<{ slug: string; id: string }> };

export async function DELETE(_req: Request, { params }: Params) {
  const org = await studioOrRefusal();
  if (org instanceof Response) return org;
  const { id } = await params;
  try {
    await deletePersonaSource(id, org.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Delete failed" }, { status: 400 });
  }
}

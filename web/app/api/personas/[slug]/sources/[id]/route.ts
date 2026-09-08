import { NextResponse } from "next/server";
import { getTrainerOrg } from "@/lib/org";
import { deletePersonaSource } from "@/lib/persona-synthesis";

type Params = { params: Promise<{ slug: string; id: string }> };

export async function DELETE(_req: Request, { params }: Params) {
  const org = await getTrainerOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    await deletePersonaSource(id, org.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Delete failed" }, { status: 400 });
  }
}

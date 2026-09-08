import { NextResponse } from "next/server";
import { getTrainerOrg } from "@/lib/org";
import { analyzePersonaSource } from "@/lib/persona-synthesis";

type Params = { params: Promise<{ slug: string; id: string }> };

export async function POST(_req: Request, { params }: Params) {
  const org = await getTrainerOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  // Fire analysis in the background and return immediately.
  // The UI polls GET /api/personas/[slug]/sources to track status.
  analyzePersonaSource(id, org.id).catch((error) => {
    console.error(`[persona-synthesis] analyze failed for source ${id}:`, error);
  });
  return NextResponse.json({ ok: true, status: "analyzing" });
}

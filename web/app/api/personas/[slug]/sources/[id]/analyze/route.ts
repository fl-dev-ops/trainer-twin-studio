import { NextResponse } from "next/server";
import { getTrainerOrg } from "@/lib/org";
import { enqueuePersonaAnalysis } from "@/lib/persona-analysis-queue";

type Params = { params: Promise<{ slug: string; id: string }> };

export async function POST(_req: Request, { params }: Params) {
  const org = await getTrainerOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const result = await enqueuePersonaAnalysis(id, org.id);
    return NextResponse.json({ ok: true, status: "uploaded", ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to queue analysis" },
      { status: 500 },
    );
  }
}

import { NextResponse, after } from "next/server";
import { getTrainerOrg } from "@/lib/org";
import { listPersonaSources, uploadPersonaSource } from "@/lib/persona-synthesis";
import { drainPersonaAnalysisQueue } from "@/lib/persona-analysis-queue";

type Params = { params: Promise<{ slug: string }> };

export async function GET(_req: Request, { params }: Params) {
  const org = await getTrainerOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { slug } = await params;
  try {
    const sources = await listPersonaSources(slug, org.id);
    return NextResponse.json({ sources });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: Params) {
  const org = await getTrainerOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { slug } = await params;
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Missing file" }, { status: 400 });
    const source = await uploadPersonaSource(org.id, slug, file);
    after(() => drainPersonaAnalysisQueue().catch((e) => console.error("[persona-queue] drain failed:", e)));
    return NextResponse.json({ ok: true, ...source });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Upload failed" }, { status: 400 });
  }
}

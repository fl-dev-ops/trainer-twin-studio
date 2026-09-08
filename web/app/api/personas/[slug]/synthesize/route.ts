import { NextResponse } from "next/server";
import { getTrainerOrg } from "@/lib/org";
import { synthesizePersona } from "@/lib/persona-synthesis";

type Params = { params: Promise<{ slug: string }> };

export async function POST(_req: Request, { params }: Params) {
  const org = await getTrainerOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { slug } = await params;
  try {
    const personaYaml = await synthesizePersona(slug, org.id);
    return NextResponse.json({ ok: true, yaml: personaYaml });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Synthesis failed" },
      { status: 400 },
    );
  }
}

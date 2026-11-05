import { NextResponse } from "next/server";
import { getTrainerOrg } from "@/lib/org";
import { usedIn } from "@/lib/skill-sources";

type Params = { params: Promise<{ id: string }> };

/** The twin skills / role plays whose live version was built from this knowledge base document (lib/skill-sources.ts). */
export async function GET(_req: Request, { params }: Params) {
  const trainer = await getTrainerOrg();
  if (!trainer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  return NextResponse.json({ usedIn: await usedIn(trainer.id, id) });
}

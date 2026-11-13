import { NextResponse } from "next/server";
import { studioOrRefusal } from "@/lib/org";
import { usedIn } from "@/lib/skill-sources";

type Params = { params: Promise<{ id: string }> };

/** The twin skills / role plays whose live version was built from this knowledge base document (lib/skill-sources.ts). */
export async function GET(_req: Request, { params }: Params) {
  const trainer = await studioOrRefusal();
  if (trainer instanceof Response) return trainer;
  const { id } = await params;
  return NextResponse.json({ usedIn: await usedIn(trainer.id, id) });
}

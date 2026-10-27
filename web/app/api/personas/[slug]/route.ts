import { NextResponse } from "next/server";
import { getTrainerOrg } from "@/lib/org";
import { PersonaError, savePersona } from "@/lib/personas";

/** Update a role-play persona (versioned). Studio only (admin, team). */
export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const org = await getTrainerOrg();
  if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    return NextResponse.json(await savePersona(org.id, await request.json().catch(() => null), (await params).slug));
  } catch (error) {
    if (error instanceof PersonaError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

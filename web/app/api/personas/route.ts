import { NextResponse } from "next/server";
import { getTrainerOrg } from "@/lib/org";
import { PersonaError, savePersona } from "@/lib/personas";

/** Create a role-play persona. Studio only (admin, team). */
export async function POST(request: Request) {
  const org = await getTrainerOrg();
  if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    return NextResponse.json(await savePersona(org.id, await request.json().catch(() => null)), { status: 201 });
  } catch (error) {
    if (error instanceof PersonaError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

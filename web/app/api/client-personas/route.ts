import { NextResponse } from "next/server";
import { ClientPersonaError, saveClientPersona } from "@/lib/client-persona-store";
import { getTrainerOrg } from "@/lib/org";

/** Create a client persona. */
export async function POST(request: Request) {
  const org = await getTrainerOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await saveClientPersona(org.id, await request.json().catch(() => null)), { status: 201 });
  } catch (error) {
    if (error instanceof ClientPersonaError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error("Client persona create failed", error);
    return NextResponse.json({ error: "Could not save the persona" }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { ClientPersonaError, saveClientPersona } from "@/lib/client-persona-store";
import { getTrainerOrg } from "@/lib/org";

/** Update a client persona. */
export async function PUT(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const org = await getTrainerOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { slug } = await params;
  try {
    return NextResponse.json(await saveClientPersona(org.id, await request.json().catch(() => null), slug));
  } catch (error) {
    if (error instanceof ClientPersonaError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error("Client persona update failed", error);
    return NextResponse.json({ error: "Could not save the persona" }, { status: 500 });
  }
}

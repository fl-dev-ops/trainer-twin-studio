import { NextResponse } from "next/server";
import { ClientPersonaError, deleteClientPersona, saveClientPersona } from "@/lib/client-persona-store";
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

/** Delete a client persona that no scenario uses. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const org = await getTrainerOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { slug } = await params;
  try {
    await deleteClientPersona(org.id, slug);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ClientPersonaError) return NextResponse.json({ error: error.message }, { status: error.message === "Persona not found" ? 404 : 409 });
    console.error("Client persona delete failed", error);
    return NextResponse.json({ error: "Could not delete the persona" }, { status: 500 });
  }
}

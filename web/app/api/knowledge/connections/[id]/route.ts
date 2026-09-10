import { NextResponse } from "next/server";
import { getTrainerOrg } from "@/lib/org";
import { deleteConnection } from "@/lib/connectors";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  props: { params: Promise<{ id: string }> }
) {
  const trainer = await getTrainerOrg();
  if (!trainer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await props.params;
  const url = new URL(request.url);
  const providerParam = url.searchParams.get("provider");
  const provider =
    providerParam === "notion" || providerParam === "youtube" ? providerParam : undefined;

  try {
    const result = await deleteConnection(trainer.id, id, provider);
    return NextResponse.json(result);
  } catch (error) {
    console.error(`[API:connections:${id}:delete] failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete connection" },
      { status: 500 },
    );
  }
}

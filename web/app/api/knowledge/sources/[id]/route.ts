import { NextResponse } from "next/server";
import { getTrainerOrg } from "@/lib/org";
import { deleteSource } from "@/lib/connectors";

export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  props: { params: Promise<{ id: string }> }
) {
  const trainer = await getTrainerOrg();
  if (!trainer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await props.params;

  try {
    const result = await deleteSource(trainer.id, id);
    return NextResponse.json(result);
  } catch (error) {
    console.error(`[API:sources:${id}:delete] failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete source" },
      { status: 500 },
    );
  }
}

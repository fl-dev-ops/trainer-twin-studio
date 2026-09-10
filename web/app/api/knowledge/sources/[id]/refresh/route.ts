import { NextResponse } from "next/server";
import { getTrainerOrg } from "@/lib/org";
import { refreshSource } from "@/lib/connectors";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  props: { params: Promise<{ id: string }> }
) {
  const trainer = await getTrainerOrg();
  if (!trainer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await props.params;

  try {
    const result = await refreshSource(trainer.id, trainer.user.id, id);
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    console.error(`[API:sources:${id}:refresh] failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to refresh source" },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";
import { studioOrRefusal } from "@/lib/org";
import { refreshSource } from "@/lib/connectors";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  props: { params: Promise<{ id: string }> }
) {
  const trainer = await studioOrRefusal();
  if (trainer instanceof Response) return trainer;

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

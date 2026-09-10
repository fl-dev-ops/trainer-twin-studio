import { NextResponse } from "next/server";
import { getTrainerOrg } from "@/lib/org";
import { getConnectorsOverview } from "@/lib/connectors";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const trainer = await getTrainerOrg();
  if (!trainer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const url = new URL(request.url);
    const kbId = url.searchParams.get("kbId") ?? undefined;
    const kbSlug = url.searchParams.get("kbSlug") ?? undefined;

    const data = await getConnectorsOverview(trainer.id, kbId || kbSlug);
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API:connectors] failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load connectors" },
      { status: 500 },
    );
  }
}

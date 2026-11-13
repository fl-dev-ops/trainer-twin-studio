import { NextResponse } from "next/server";
import { studioOrRefusal } from "@/lib/org";
import { notionImportSchema } from "@/lib/notion";
import { queueNotionSync } from "@/lib/notion-ingestion";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const trainer = await studioOrRefusal();
  if (trainer instanceof Response) return trainer;

  try {
    const json = await request.json();
    const parsed = notionImportSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request payload", details: parsed.error.format() },
        { status: 400 },
      );
    }

    const result = await queueNotionSync({
      orgId: trainer.id,
      userId: trainer.user.id,
      ...parsed.data,
    });

    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    console.error("[API:connectors:notion] failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to import Notion content" },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";
import { getTrainerOrg } from "@/lib/org";
import { listNotionImports, queueNotionSync } from "@/lib/notion-ingestion";
import { notionImportSchema } from "@/lib/notion";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ kb: string }> };

export async function GET(_request: Request, { params }: Params) {
  const trainer = await getTrainerOrg();
  if (!trainer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { kb } = await params;
  try {
    const data = await listNotionImports(trainer.id, kb);
    return NextResponse.json(data);
  } catch (error) {
    console.error(`[API:knowledge:${kb}:notion:get] failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not list Notion imports" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request, { params }: Params) {
  const trainer = await getTrainerOrg();
  if (!trainer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { kb } = await params;
  try {
    const json = await request.json().catch(() => null);
    const parsed = notionImportSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid Notion import payload", details: parsed.error.format() },
        { status: 400 },
      );
    }

    const result = await queueNotionSync({
      orgId: trainer.id,
      userId: trainer.user.id,
      kbSlug: kb,
      ...parsed.data,
    });
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    console.error(`[API:knowledge:${kb}:notion:post] failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not queue Notion sync" },
      { status: 500 },
    );
  }
}

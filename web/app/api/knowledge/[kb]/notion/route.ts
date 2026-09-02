import { NextResponse } from "next/server";
import { listNotionImports, queueNotionSync } from "@/lib/notion-ingestion";
import { notionImportSchema } from "@/lib/notion";
import { resolveSessionUser } from "@/lib/session-user";

export const runtime = "nodejs";

type Params = { params: Promise<{ kb: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { kb } = await params;
  try {
    return NextResponse.json(await listNotionImports(org.id, user.id, kb));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not list Notion imports" },
      { status: 404 },
    );
  }
}

export async function POST(request: Request, { params }: Params) {
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = notionImportSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid Notion import" }, { status: 400 });
  const { kb } = await params;
  try {
    const queued = await queueNotionSync({
      orgId: org.id,
      userId: user.id,
      kbSlug: kb,
      ...parsed.data,
    });
    return NextResponse.json(queued, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not queue Notion sync" },
      { status: 400 },
    );
  }
}

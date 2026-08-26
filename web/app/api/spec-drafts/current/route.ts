import { NextResponse } from "next/server";
import { listSpecDrafts, readSpecDraft } from "@/lib/spec-drafts";

export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get("slug");
  const slug = requested ?? (await listSpecDrafts())[0]?.slug;
  if (!slug) return new NextResponse(null, { status: 404 });
  const draft = await readSpecDraft(slug);
  if (!draft) return new NextResponse(null, { status: 404 });
  return NextResponse.json(draft);
}

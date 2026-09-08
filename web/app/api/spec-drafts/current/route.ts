import { NextResponse } from "next/server";
import { getTrainerOrg } from "@/lib/org";
import { listSpecDrafts, readSpecDraft } from "@/lib/spec-drafts";

export async function GET(request: Request) {
  const org = await getTrainerOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const requested = new URL(request.url).searchParams.get("slug");
  const slug = requested ?? (await listSpecDrafts(org.id))[0]?.slug;
  if (!slug) return new NextResponse(null, { status: 404 });
  const draft = await readSpecDraft(slug, org.id);
  if (!draft) return new NextResponse(null, { status: 404 });
  return NextResponse.json(draft);
}

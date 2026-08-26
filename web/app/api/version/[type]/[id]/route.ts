import { NextResponse } from "next/server";
import { getSessionOrg } from "@/lib/org";
import { isSpecType, readVersion } from "@/lib/specs";

type Params = { params: Promise<{ type: string; id: string }> };

export async function GET(req: Request, { params }: Params) {
  const { type, id } = await params;
  if (!isSpecType(type)) return NextResponse.json({ error: "Bad type" }, { status: 400 });
  const version = Number(new URL(req.url).searchParams.get("v") ?? NaN);
  if (!Number.isInteger(version)) {
    return NextResponse.json({ error: "Missing version" }, { status: 400 });
  }
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const row = await readVersion(type, id, version, org.id);
  if (row === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ text: row.text });
}

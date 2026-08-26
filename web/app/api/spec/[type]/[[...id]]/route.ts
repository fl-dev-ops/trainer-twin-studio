import { NextResponse } from "next/server";
import { getSessionOrg } from "@/lib/org";
import {
  deleteSpec,
  isSpecType,
  listVersions,
  listSpecs,
  readSpec,
  saveSpec,
} from "@/lib/specs";

type Params = { params: Promise<{ type: string; id?: string[] }> };

export async function GET(_req: Request, { params }: Params) {
  const { type, id } = await params;
  if (!isSpecType(type)) return NextResponse.json({ error: "Bad type" }, { status: 400 });
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!id) return NextResponse.json({ specs: await listSpecs(type, org.id) });

  const specId = id.join("/");
  try {
    const spec = await readSpec(type, specId, org.id);
    if (!spec) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({
      text: spec.text,
      version: spec.version,
      versions: await listVersions(type, specId, org.id),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Read failed" },
      { status: 400 },
    );
  }
}

export async function PUT(req: Request, { params }: Params) {
  const { type, id } = await params;
  if (!isSpecType(type) || !id) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (typeof body?.text !== "string") {
    return NextResponse.json({ error: "Missing text" }, { status: 400 });
  }
  try {
    const result = await saveSpec(type, id.join("/"), body.text, org.id);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Save failed" },
      { status: 400 },
    );
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { type, id } = await params;
  if (!isSpecType(type) || !id) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await deleteSpec(type, id.join("/"), org.id);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

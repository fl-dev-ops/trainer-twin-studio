import { NextResponse } from "next/server";
import { ChromaTenantService } from "@/lib/chroma-tenant";
import { db } from "@/lib/db";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const org = await db.organization.findUnique({ where: { id: orgId } });
  if (!org) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  try {
    const result = await ChromaTenantService.createOrgDatabase(orgId);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create Chroma tenant" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const org = await db.organization.findUnique({ where: { id: orgId } });
  if (!org) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  try {
    await ChromaTenantService.deleteOrgDatabase(orgId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete Chroma tenant" },
      { status: 500 },
    );
  }
}

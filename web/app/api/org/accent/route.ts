import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

function isValidHex(v: string) {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);
}

export async function PATCH(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const member = await db.member.findFirst({
    where: { userId: session.user.id },
    select: { organizationId: true, role: true, organization: { select: { metadata: true } } },
  });
  if (!member) return NextResponse.json({ error: "No organization" }, { status: 403 });
  if (member.role !== "owner" && member.role !== "admin")
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const accentColor = String(body.accentColor ?? "").trim();
  if (!isValidHex(accentColor))
    return NextResponse.json({ error: "Invalid hex color" }, { status: 422 });

  // ponytail PT-1: merging into the metadata JSON blob; add a typed column when it grows.
  const existing = (() => {
    try { return JSON.parse(member.organization.metadata ?? "{}"); }
    catch { return {}; }
  })();

  await db.organization.update({
    where: { id: member.organizationId },
    data: { metadata: JSON.stringify({ ...existing, accentColor }) },
  });

  return NextResponse.json({ accentColor });
}

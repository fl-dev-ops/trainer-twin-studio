import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { currentMembership, isStudioRole } from "@/lib/org";

const bodySchema = z.object({
  accentColor: z.string().regex(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i),
  websiteUrl: z.string().trim().max(2048).refine((value) => {
    if (!value) return true;
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }),
}).strict();

export async function PATCH(request: Request) {
  const current = await currentMembership(await headers());
  if (!current) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { member } = current;
  if (!member) return NextResponse.json({ error: "No organization" }, { status: 403 });
  if (!isStudioRole(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a valid HTTPS website URL" }, { status: 422 });
  }

  const existing = (() => {
    try { return JSON.parse(member.organization.metadata ?? "{}"); }
    catch { return {}; }
  })();
  const websiteUrl = parsed.data.websiteUrl
    ? new URL(parsed.data.websiteUrl).toString()
    : null;

  await db.organization.update({
    where: { id: member.organization.id },
    data: {
      websiteUrl,
      metadata: JSON.stringify({ ...existing, accentColor: parsed.data.accentColor }),
    },
  });

  return NextResponse.json({ accentColor: parsed.data.accentColor, websiteUrl });
}

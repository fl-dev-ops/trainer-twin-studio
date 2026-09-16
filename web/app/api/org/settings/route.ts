import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

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
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const member = await db.member.findFirst({
    where: { userId: session.user.id },
    select: { organizationId: true, role: true, organization: { select: { metadata: true } } },
  });
  if (!member) return NextResponse.json({ error: "No organization" }, { status: 403 });
  if (!member.role.split(",").some((role) => ["owner", "admin"].includes(role.trim()))) {
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
    where: { id: member.organizationId },
    data: {
      websiteUrl,
      metadata: JSON.stringify({ ...existing, accentColor: parsed.data.accentColor }),
    },
  });

  return NextResponse.json({ accentColor: parsed.data.accentColor, websiteUrl });
}

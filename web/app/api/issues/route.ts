import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { portalSlug } from "@/lib/base-domain";
import { db } from "@/lib/db";
import { getOrgBySlug } from "@/lib/org";

const bodySchema = z
  .object({
    kind: z.enum(["bug", "feature", "other"]).default("bug"),
    message: z.string().trim().min(5).max(5000),
    url: z.string().trim().max(2048).optional().nullable(),
  })
  .strict();

export async function POST(request: Request) {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Please describe the issue (5–5000 characters)" },
      { status: 422 },
    );
  }

  // Attribute the report to the reporter's organization: trainers belong via
// membership; learners on an org subdomain are resolved from the host slug
// (mirrors resolveSessionUser in lib/session-user.ts).
const host = requestHeaders.get("host") ?? "";
const portalOrg = host ? await getOrgBySlug(portalSlug(host)) : null;
const member = portalOrg
  ? null
  : await db.member.findFirst({
      where: { userId: session.user.id },
      select: { organizationId: true },
    });

const report = await db.issueReport.create({
  data: {
    kind: parsed.data.kind,
    message: parsed.data.message,
    url: parsed.data.url ?? null,
    userAgent: requestHeaders.get("user-agent")?.slice(0, 500) ?? null,
    userId: session.user.id,
    orgId: portalOrg?.id ?? member?.organizationId ?? null,
  },
  select: { id: true },
});

  return NextResponse.json({ id: report.id }, { status: 201 });
}
import { NextResponse } from "next/server";
import { getOrgBySlug } from "@/lib/org";
import { db } from "@/lib/db";

/**
 * Public agent catalog for a learner portal. `org` comes from the subdomain in
 * production; pass it explicitly until host resolution is wired into fetches.
 */
export async function GET(request: Request) {
  const slug =
    new URL(request.url).searchParams.get("org") ??
    (request.headers.get("host") ?? "").split(".")[0];
  if (!slug) return NextResponse.json({ agents: [] });

  const org = await getOrgBySlug(slug);
  if (!org) return NextResponse.json({ agents: [] });

  const agents = await db.agent.findMany({
    where: { orgId: org.id, visibility: "public" },
    orderBy: { name: "asc" },
    select: { slug: true, name: true, version: true, domainSlug: true },
  });
  return NextResponse.json({ org: org.slug, agents });
}

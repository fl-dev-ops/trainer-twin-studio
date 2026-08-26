import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export type SessionOrg = { id: string; slug: string };

/**
 * The signed-in trainer's organization (orgLimit is 1, so at most one).
 * Null when unauthenticated or not yet part of an organization.
 */
export async function getSessionOrg(): Promise<SessionOrg | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  const member = await db.member.findFirst({
    where: { userId: session.user.id },
    select: { organization: { select: { id: true, slug: true } } },
  });
  return member ? { id: member.organization.id, slug: member.organization.slug } : null;
}

/** Org by subdomain slug — for learner-facing surfaces. */
export async function getOrgBySlug(slug: string): Promise<SessionOrg | null> {
  const org = await db.organization.findUnique({
    where: { slug },
    select: { id: true, slug: true },
  });
  return org;
}

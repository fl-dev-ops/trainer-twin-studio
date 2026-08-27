import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export type SessionOrg = { id: string; slug: string; accentColor: string | null };

// ponytail PT-1: accentColor parsed from the metadata JSON blob; move to a
// typed column on Organization when the metadata bag holds 3+ keys or needs
// DB-level queries.
export function parseAccentColor(metadata: string | null): string | null {
  try {
    const m = JSON.parse(metadata ?? "{}");
    return typeof m.accentColor === "string" ? m.accentColor : null;
  } catch {
    return null;
  }
}

/**
 * The signed-in trainer's organization (orgLimit is 1, so at most one).
 * Null when unauthenticated or not yet part of an organization.
 */
export async function getSessionOrg(): Promise<SessionOrg | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  const member = await db.member.findFirst({
    where: { userId: session.user.id },
    select: { organization: { select: { id: true, slug: true, metadata: true } } },
  });
  if (!member) return null;
  return {
    id: member.organization.id,
    slug: member.organization.slug,
    accentColor: parseAccentColor(member.organization.metadata),
  };
}

/** Org by subdomain slug — for learner-facing surfaces. */
export async function getOrgBySlug(slug: string): Promise<SessionOrg | null> {
  const org = await db.organization.findUnique({
    where: { slug },
    select: { id: true, slug: true, metadata: true },
  });
  if (!org) return null;
  return { id: org.id, slug: org.slug, accentColor: parseAccentColor(org.metadata) };
}

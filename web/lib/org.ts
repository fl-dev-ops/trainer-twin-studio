import { db } from "@/lib/db";
import { resolveSessionUser } from "@/lib/session-user";

export type SessionOrg = { id: string; slug: string; accentColor: string | null; basePath: string | null };

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

/** Tenant subpath prefix (e.g. "/interview") from the Organization.config JSON blob. */
export function parseBasePath(config: unknown): string | null {
  let parsed: unknown = config;
  if (typeof config === "string") {
    try {
      parsed = JSON.parse(config);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const basePath = (parsed as Record<string, unknown>).basePath;
  return typeof basePath === "string" && basePath.startsWith("/") ? basePath : null;
}
/**
 * The signed-in trainer's organization (orgLimit is 1, so at most one).
 * Null when unauthenticated or not yet part of an organization.
 * Delegates to resolveSessionUser so host-delegated and subdomain modes share
 * one tenant-resolution path.
 */
export async function getSessionOrg(): Promise<SessionOrg | null> {
  const { org } = await resolveSessionUser();
  return org;
}

/** Org by subdomain slug — for learner-facing surfaces. */
export async function getOrgBySlug(slug: string): Promise<SessionOrg | null> {
  const org = await db.organization.findUnique({
    where: { slug },
    select: { id: true, slug: true, metadata: true, config: true },
  });
  if (!org) return null;
  return {
    id: org.id,
    slug: org.slug,
    accentColor: parseAccentColor(org.metadata),
    basePath: parseBasePath(org.config),
  };
}

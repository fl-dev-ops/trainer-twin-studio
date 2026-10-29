import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * Org roles on `member.role` (one per member, CHECK member_role_check): admin and team run the studio
 * with identical access; user only practises (twin / role play).
 */
export const STUDIO_ROLES = ["admin", "team"] as const;
export const LEARNER_ROLE = "user";
export type OrgRole = (typeof STUDIO_ROLES)[number] | typeof LEARNER_ROLE;
export const isStudioRole = (role: string | null | undefined) => role === "admin" || role === "team";

/** hideRoleplay: org metadata flag for twin-only orgs (no Role play menus or pages). */
export type SessionOrg = { id: string; slug: string; accentColor: string | null; hideRoleplay?: boolean };
export type TrainerOrg = SessionOrg & {
  role: string;
  user: { id: string; name: string; email: string };
};

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

/** `{ "hideRoleplay": true }` in the org metadata: a twin-only org (set per org in the database). */
export function parseHideRoleplay(metadata: string | null): boolean {
  try {
    return JSON.parse(metadata ?? "{}").hideRoleplay === true;
  } catch {
    return false;
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
    // Disabled members are out at once, even while their cached session cookie (lib/auth.ts) is still valid.
    where: { userId: session.user.id, disabledAt: null },
    select: { organization: { select: { id: true, slug: true, metadata: true } } },
  });
  if (!member) return null;
  return {
    id: member.organization.id,
    slug: member.organization.slug,
    accentColor: parseAccentColor(member.organization.metadata),
    hideRoleplay: parseHideRoleplay(member.organization.metadata),
  };
}

/** The signed-in studio member (admin or team) and their organization. */
export async function getTrainerOrg(): Promise<TrainerOrg | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  const member = await db.member.findFirst({
    // Disabled members are out at once, even while their cached session cookie (lib/auth.ts) is still valid.
    where: { userId: session.user.id, disabledAt: null },
    select: {
      role: true,
      organization: { select: { id: true, slug: true, metadata: true } },
    },
  });
  if (!member || !isStudioRole(member.role)) {
    return null;
  }
  return {
    id: member.organization.id,
    slug: member.organization.slug,
    accentColor: parseAccentColor(member.organization.metadata),
    hideRoleplay: parseHideRoleplay(member.organization.metadata),
    role: member.role,
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
  };
}

/**
 * Page guard for studio pages (twin, calibration): admin and team only. Learners (`user`) and anyone
 * outside an org are sent to the learner landing page. APIs use `studioProcedure` / `getTrainerOrg`.
 */
export async function requireStudioMember(): Promise<TrainerOrg> {
  const org = await getTrainerOrg();
  if (!org) redirect("/auth/no-org");
  return org;
}

/** Page guard for Role play pages (scenarios, personas): studio members of an org that has role play. */
export async function requireRoleplayOrg(): Promise<TrainerOrg> {
  const org = await requireStudioMember();
  if (org.hideRoleplay) redirect("/twin");
  return org;
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

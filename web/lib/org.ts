import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { ORG_PIN_HEADER } from "@/lib/org-pin";

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
 * Which of a person's memberships they're working in (people may belong to several orgs). Studio memberships first:
 * the org this tab is pinned to, else the session's active org (the org switcher), else the oldest. A person with no
 * studio membership gets their active org, else their oldest. Learner pages don't use this; their org is the subdomain.
 */
export function pickMembership<M extends { role: string; organization: { id: string } }>(
  memberships: M[],
  activeOrgId?: string | null,
  pinnedOrgId?: string | null,
): M | null {
  const studio = memberships.filter((member) => isStudioRole(member.role));
  const find = (list: M[], orgId?: string | null) => (orgId ? list.find((member) => member.organization.id === orgId) : undefined);
  return find(studio, pinnedOrgId) ?? find(studio, activeOrgId) ?? studio[0] ?? find(memberships, activeOrgId) ?? memberships[0] ?? null;
}

const membershipSelect = {
  role: true,
  organization: { select: { id: true, slug: true, name: true, metadata: true } },
} as const;

/** All enabled memberships, oldest first: disabled ones are out at once, even while the cached session cookie (lib/auth.ts) is still valid. */
export const enabledMemberships = (userId: string) =>
  db.member.findMany({ where: { userId, disabledAt: null }, orderBy: { createdAt: "asc" }, select: membershipSelect });

/** The membership this request works in (pickMembership), from the request headers. */
export async function currentMembership(requestHeaders: Headers) {
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return null;
  const member = pickMembership(
    await enabledMemberships(session.user.id),
    session.session.activeOrganizationId,
    requestHeaders.get(ORG_PIN_HEADER),
  );
  return { session, member };
}

/** The studio orgs this person can switch between (the org switcher shows when there are two or more). */
export async function studioOrgsOf(userId: string) {
  const memberships = await enabledMemberships(userId);
  return memberships
    .filter((member) => isStudioRole(member.role))
    .map(({ organization }) => ({ id: organization.id, name: organization.name, slug: organization.slug }));
}

/**
 * The signed-in person's current organization (pickMembership), any role.
 * Null when unauthenticated or not yet part of an organization.
 */
export async function getSessionOrg(): Promise<SessionOrg | null> {
  const member = (await currentMembership(await headers()))?.member;
  if (!member) return null;
  return {
    id: member.organization.id,
    slug: member.organization.slug,
    accentColor: parseAccentColor(member.organization.metadata),
    hideRoleplay: parseHideRoleplay(member.organization.metadata),
  };
}

/** The signed-in studio member (admin or team) and the organization they're working in. */
export async function getTrainerOrg(): Promise<TrainerOrg | null> {
  const current = await currentMembership(await headers());
  if (!current) return null;
  const { session, member } = current;
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

/** Which of these emails are the org's admin and team, lower-cased (they practise without using credits). */
export async function studioEmails(orgId: string, emails: string[]) {
  const rows = await db.member.findMany({
    where: { organizationId: orgId, role: { in: [...STUDIO_ROLES] }, OR: emails.map((email) => ({ user: { email: { equals: email, mode: "insensitive" as const } } })) },
    select: { user: { select: { email: true } } },
  });
  return new Set(rows.map((row) => row.user.email.toLowerCase()));
}

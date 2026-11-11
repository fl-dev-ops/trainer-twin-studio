import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { AppError, errorResponse, refusals } from "@/lib/errors";
import { ORG_PIN_HEADER } from "@/lib/org-pin";

import { isStudioRole } from "@/lib/roles";

export { isStudioRole, LEARNER_ROLE, STUDIO_ROLES, type OrgRole } from "@/lib/roles";

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
  const accent = orgMetadata(metadata).accentColor;
  return typeof accent === "string" ? accent : null;
}

/** `{ "hideRoleplay": true }` in the org metadata: a twin-only org (set per org in the database). */
export function parseHideRoleplay(metadata: string | null): boolean {
  return orgMetadata(metadata).hideRoleplay === true;
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
export const enabledMemberships = async (userId: string) => (await allMemberships(userId)).filter((member) => !member.disabledAt);

const allMemberships = (userId: string) =>
  db.member.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, select: { ...membershipSelect, disabledAt: true } });

/**
 * The membership this request works in (pickMembership), from the request headers; null when signed out. The login
 * may come from the 5-minute cookie cache, so memberships are always read from the database (specs/people.md rule 14).
 * A tab's org header that is no longer an enabled studio membership is refused, never swapped for another org (rule 16).
 */
export async function currentMembership(requestHeaders: Headers) {
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return null;
  const all = await allMemberships(session.user.id);
  const memberships = all.filter((member) => !member.disabledAt);
  const pinned = requestHeaders.get(ORG_PIN_HEADER);
  // Turned off in the org asked for (or in every org): member_disabled, not "not a member".
  const disabledIn = (orgId?: string | null) => all.some((member) => member.organization.id === orgId && member.disabledAt);
  if (pinned && !memberships.some((member) => member.organization.id === pinned && isStudioRole(member.role))) {
    return { session, member: null, refusal: disabledIn(pinned) ? refusals.memberDisabled() : refusals.orgPinInvalid() };
  }
  const member = pickMembership(memberships, session.session.activeOrganizationId, pinned);
  if (member) return { session, member, refusal: null };
  return { session, member: null, refusal: all.length ? refusals.memberDisabled() : refusals.noOrg() };
}

/** The refusal for a request that isn't from a studio member (signed_out, org_pin_invalid, no_org, studio_only). */
export function studioRefusal(current: Awaited<ReturnType<typeof currentMembership>>): AppError | null {
  if (!current) return refusals.signedOut();
  if (current.refusal) return current.refusal;
  return current.member && isStudioRole(current.member.role) ? null : refusals.studioOnly();
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

/**
 * The signed-in studio member (admin or team) and the org they're working in, or our refusal (specs/people.md
 * Refusals). Route handlers: `try { const org = await studioOrg(); … } catch (error) { return errorResponse(error); }`.
 */
export async function studioOrg(): Promise<TrainerOrg> {
  const current = await currentMembership(await headers());
  const refusal = studioRefusal(current);
  if (refusal) throw refusal;
  const { session, member } = current!;
  if (!member) throw refusals.noOrg();
  return {
    id: member.organization.id,
    slug: member.organization.slug,
    accentColor: parseAccentColor(member.organization.metadata),
    hideRoleplay: parseHideRoleplay(member.organization.metadata),
    role: member.role,
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
  };
}

/** For route handlers: the studio member's org, or our refusal as the response (`if (org instanceof Response) return org`). */
export const studioOrRefusal = (): Promise<TrainerOrg | Response> => studioOrg().catch((error: unknown) => errorResponse(error));

/** studioOrg, or null instead of the refusal (pages that redirect, callers that only need yes/no). */
export const getTrainerOrg = () => studioOrg().catch((error: unknown) => {
  if (error instanceof AppError) return null;
  throw error;
});

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

/** The org's metadata JSON (staff-set flags such as hideRoleplay, and accentColor); {} when unreadable. */
export function orgMetadata(metadata: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(metadata ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const LOGO = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
export const MAX_LOGO_BYTES = 1_000_000;
// The first bytes of each allowed type: the data URL's label alone proves nothing.
const MAGIC: Record<string, (bytes: Buffer) => boolean> = {
  png: (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  webp: (bytes) => bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP",
};

/** A logo the org may use: a PNG/JPEG/WebP image (by its bytes) of at most MAX_LOGO_BYTES (specs/people.md rule 21). */
export function isValidLogo(logo: string) {
  const match = LOGO.exec(logo);
  if (!match) return false;
  const bytes = Buffer.from(match[2], "base64");
  return bytes.length <= MAX_LOGO_BYTES && MAGIC[match[1]](bytes);
}

/**
 * Saves the org's branding in one write (specs/people.md rule 21): name, logo (null removes it), website (null removes
 * it) and accent colour. The subdomain and the staff-set metadata flags are kept as they are.
 */
export async function updateOrgSettings(orgId: string, input: { name: string; logo: string | null; websiteUrl: string | null; accentColor: string }) {
  if (input.logo !== null && !isValidLogo(input.logo)) throw new AppError("logo_invalid", "Use a PNG, JPEG or WebP logo up to 1 MB.", 400);
  const org = await db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { metadata: true } });
  return db.organization.update({
    where: { id: orgId },
    data: {
      name: input.name,
      logo: input.logo,
      websiteUrl: input.websiteUrl,
      metadata: JSON.stringify({ ...orgMetadata(org.metadata), accentColor: input.accentColor }),
    },
    select: { name: true, logo: true, websiteUrl: true },
  });
}

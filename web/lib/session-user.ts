import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { portalSlug, signInUrl } from "@/lib/base-domain";
import type { Prisma } from "@/lib/generated/prisma/client";
import { currentMembership, getOrgBySlug, isStudioRole, parseAccentColor } from "@/lib/org";
import { orgPerson } from "@/lib/org-people";
import type { SessionOrg } from "@/lib/org";

/** Organization from the learner subdomain (or membership on studio hosts) plus user identity. */
export async function resolveSessionUser(): Promise<{
  org: SessionOrg | null;
  user: { id: string; name: string; email: string } | null;
  signInUrl: string;
}> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "";
  const [session, portalOrg] = await Promise.all([
    auth.api.getSession({ headers: requestHeaders }),
    getOrgBySlug(portalSlug(host)),
  ]);
  if (!session) return { org: portalOrg, user: null, signInUrl: signInUrl(host) };

  const member = portalOrg ? null : (await currentMembership(requestHeaders))?.member;
  const org: SessionOrg | null =
    portalOrg ??
    (member
      ? {
          id: member.organization.id,
          slug: member.organization.slug,
          accentColor: parseAccentColor(member.organization.metadata),
        }
      : null);

  return {
    org,
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
    signInUrl: signInUrl(host),
  };
}

/**
 * Which of the org's practice sessions this account may open: all of them (enabled admin/team), its own (enabled
 * learner), none (null: not an enabled member; disabled counts as not a member, specs/people.md rule 14). Deleted
 * sessions are never included.
 */
export async function visibleSessions(orgId: string, userId: string): Promise<Prisma.InterviewSessionWhereInput | null> {
  const person = await orgPerson(orgId, { userId });
  if (!person || person.disabled) return null;
  return { orgId, deletedAt: null, ...(isStudioRole(person.role) ? {} : { userId }) };
}

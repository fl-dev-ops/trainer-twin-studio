import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { portalSlug, signInUrl } from "@/lib/base-domain";
import { db } from "@/lib/db";
import { getOrgBySlug, parseAccentColor } from "@/lib/org";
import type { SessionOrg } from "@/lib/org";

/** Organization from the learner subdomain (or membership on studio hosts) plus user identity. */
export async function resolveSessionUser(): Promise<{
  org: SessionOrg | null;
  user: { id: string; name: string; email: string } | null;
  signInUrl: string;
}> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "";
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return { org: null, user: null, signInUrl: signInUrl(host) };

  const portalOrg = await getOrgBySlug(portalSlug(host));
  const member = portalOrg
    ? null
    : await db.member.findFirst({
        where: { userId: session.user.id },
        select: { organization: { select: { id: true, slug: true, metadata: true } } },
      });
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

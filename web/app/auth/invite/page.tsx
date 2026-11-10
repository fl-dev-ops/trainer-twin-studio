import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { signInUrl } from "@/lib/invite/links";

export const dynamic = "force-dynamic";

/**
 * Links in invitation emails sent before people were added straight to their org (specs/people.md). Those people are
 * members now: this sends them to where they sign in (learners: their org home; admin, team: the studio).
 */
export default async function InvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const invitation = token
    ? await db.invitation.findUnique({ where: { id: token }, select: { role: true, organization: { select: { slug: true } } } })
    : null;
  redirect(invitation ? signInUrl(invitation.role, invitation.organization.slug) : "/sign-in");
}

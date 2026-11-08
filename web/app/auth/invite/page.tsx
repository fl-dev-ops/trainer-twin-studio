import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { InviteForm } from "@/components/auth/invite-form";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { learnerInviteUrl } from "@/lib/invite/links";
import { LEARNER_ROLE } from "@/lib/org";

export const dynamic = "force-dynamic";

/**
 * A studio invite (admin, team): Google sign-in with the invited email, then accept. A learner invite opens the org's
 * home page instead (older learner emails still link here), which accepts it after Google sign-in (lib/invite/accept.ts).
 */
export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const invitationId = (await searchParams).token;
  const session = await auth.api.getSession({ headers: await headers() });
  const invitation = invitationId
    ? await db.invitation.findUnique({
        where: { id: invitationId },
        select: { email: true, status: true, role: true, organization: { select: { name: true, slug: true } } },
      })
    : null;
  if (invitation?.role === LEARNER_ROLE) redirect(learnerInviteUrl(invitation.organization.slug));

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      {invitationId && invitation && invitation.status === "pending" ? (
        <InviteForm
          invitationId={invitationId}
          email={invitation.email}
          organizationName={invitation.organization.name}
          signedInEmail={session?.user.email}
        />
      ) : (
        <div className="w-full max-w-sm text-center">
          <h1 className="text-lg font-semibold">Invite required</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            This link is invalid or has already been used. Ask your trainer for a fresh one.
          </p>
          <Link href="/sign-in" className="text-foreground mt-4 inline-block text-sm underline underline-offset-4">
            Sign in
          </Link>
        </div>
      )}
    </main>
  );
}

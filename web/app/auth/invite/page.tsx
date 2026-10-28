import Link from "next/link";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { signInUrl } from "@/lib/base-domain";
import { db } from "@/lib/db";
import { InviteForm } from "@/components/auth/invite-form";

export const dynamic = "force-dynamic";

export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const invitationId = (await searchParams).token;
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  const invitation = invitationId
    ? await db.invitation.findUnique({
        where: { id: invitationId },
        select: { email: true, status: true },
      })
    : null;
  // An invited email that already has an account signs in (then accepts) instead of signing up again.
  const hasAccount = invitation && !session
    ? Boolean(await db.user.findFirst({ where: { email: { equals: invitation.email, mode: "insensitive" } }, select: { id: true } }))
    : false;
  const signInHref = invitationId
    ? signInUrl(requestHeaders.get("host") ?? "", `/invite?token=${encodeURIComponent(invitationId)}`)
    : "/sign-in";

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      {invitationId && invitation && invitation.status === "pending" ? (
        <InviteForm
          invitationId={invitationId}
          email={invitation.email}
          signedInEmail={session?.user.email}
          signInHref={hasAccount ? signInHref : undefined}
          googleEnabled={Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)}
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

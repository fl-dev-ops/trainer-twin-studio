import Link from "next/link";
import { db } from "@/lib/db";
import { InviteForm } from "@/components/auth/invite-form";

export const dynamic = "force-dynamic";

export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const invitationId = (await searchParams).token;
  const invitation = invitationId
    ? await db.invitation.findUnique({
        where: { id: invitationId },
        select: { email: true, status: true },
      })
    : null;

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      {invitationId && invitation && invitation.status === "pending" ? (
        <InviteForm invitationId={invitationId} email={invitation.email} />
      ) : (
        <div className="w-full max-w-sm text-center">
          <h1 className="text-lg font-semibold">Invite required</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            This link is invalid or has already been used. Ask your trainer for a fresh one.
          </p>
          <Link href="/auth/sign-in" className="text-foreground mt-4 inline-block text-sm underline underline-offset-4">
            Sign in
          </Link>
        </div>
      )}
    </main>
  );
}

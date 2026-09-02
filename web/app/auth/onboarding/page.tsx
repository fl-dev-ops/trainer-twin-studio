import Link from "next/link";
import { db } from "@/lib/db";
import { FounderForm } from "@/components/auth/founder-form";

export const dynamic = "force-dynamic";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) {
  const token = (await searchParams).t;
  const invite = token
    ? await db.founderInvite.findUnique({
        where: { token },
        select: { acceptedAt: true, email: true },
      })
    : null;

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      {token && invite && !invite.acceptedAt ? (
        <FounderForm token={token} email={invite.email ?? ""} />
      ) : (
        <div className="w-full max-w-sm text-center">
          <h1 className="text-lg font-semibold">Invite required</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            This link is invalid or has already been used. Ask for a fresh invite.
          </p>
          <Link href="/auth/sign-in" className="text-foreground mt-4 inline-block text-sm underline underline-offset-4">
            Sign in
          </Link>
        </div>
      )}
    </main>
  );
}

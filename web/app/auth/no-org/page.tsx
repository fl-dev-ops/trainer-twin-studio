import Link from "next/link";
import { headers } from "next/headers";
import { SwitchAccountButton } from "@/components/auth/switch-account-button";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * A signed-in account that belongs to no organization lands here. Signing in again would only bring it back (the
 * sign-in page sends signed-in people home, which is this page), so it offers to sign out and use another account.
 */
export default async function NoOrgPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
        <div>
          <h1 className="text-lg font-semibold">No practice session selected</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Open the practice link your trainer sent you to start a session.
          </p>
        </div>
        {session ? (
          <>
            <p className="text-muted-foreground text-sm">
              Signed in as <span className="text-foreground font-medium">{session.user.email}</span>. If your trainer invited a
              different account, sign out and use that one.
            </p>
            <SwitchAccountButton returnTo="/sign-in" label="Sign out" />
          </>
        ) : (
          <Link href="/sign-in" className="text-foreground text-sm underline underline-offset-4">
            Sign in
          </Link>
        )}
      </div>
    </main>
  );
}

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SignInForm } from "@/components/auth/sign-in-form";
import { auth } from "@/lib/auth";
import { resolveHome } from "@/lib/auth-home";
import { safeFamilyRedirect } from "@/lib/base-domain";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string; error?: string }>;
}) {
  const params = await searchParams;
  const requested = safeFamilyRedirect(params.redirect);
  // Already signed in? Continue to the requested session or the user's home.
  if (await auth.api.getSession({ headers: await headers() })) {
    if (requested) redirect(requested);
    const home = await resolveHome();
    if (home) redirect(home);
  }
  return (
    <main className="flex min-h-svh flex-col items-center justify-center bg-background p-6 md:p-10">
      <div className="w-full max-w-sm">
        <SignInForm
          redirectTo={requested ?? undefined}
          error={params.error ? signInError(params.error) : undefined}
          googleEnabled={Boolean(
            process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
          )}
        />
      </div>
    </main>
  );
}

/** Why Google sign-in was refused, in the person's words (Better Auth's error codes). No self sign-up: specs/people.md. */
function signInError(code: string) {
  return code === "signup_disabled" || code === "signup disabled"
    ? "There's no TrainerTwin account for that Google email. Sign in with the email your trainer added, or ask them to add you."
    : "Google sign-in didn't work. Try again, or sign in with a code sent to your email.";
}

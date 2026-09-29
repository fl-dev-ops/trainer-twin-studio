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
  searchParams: Promise<{ redirect?: string }>;
}) {
  const requested = safeFamilyRedirect((await searchParams).redirect);
  // Already signed in? Continue to the requested session or the user's home.
  if (await auth.api.getSession({ headers: await headers() })) {
    if (requested) redirect(requested);
    const home = await resolveHome();
    if (home) redirect(home);
  }
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <SignInForm redirectTo={requested ?? undefined} googleEnabled={Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)} />
    </main>
  );
}

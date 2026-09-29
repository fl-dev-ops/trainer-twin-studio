import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SignUpForm } from "@/components/auth/sign-up-form";
import { auth } from "@/lib/auth";
import { resolveHome } from "@/lib/auth-home";
import { safeFamilyRedirect } from "@/lib/base-domain";

export const dynamic = "force-dynamic";

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  const requested = safeFamilyRedirect((await searchParams).redirect);
  if (await auth.api.getSession({ headers: await headers() })) {
    if (requested) redirect(requested);
    const home = await resolveHome();
    if (home) redirect(home);
  }

  return (
    <main className="flex min-h-svh flex-col items-center justify-center bg-background p-6 md:p-10">
      <div className="w-full max-w-sm">
        <SignUpForm
          redirectTo={requested ?? undefined}
          googleEnabled={Boolean(
            process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
          )}
        />
      </div>
    </main>
  );
}

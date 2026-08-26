import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SignInForm } from "@/components/auth/sign-in-form";
import { auth } from "@/lib/auth";
import { resolveHome } from "@/lib/auth-home";

export const dynamic = "force-dynamic";

export default async function SignInPage() {
  // Already signed in? Go straight to your area.
  if (await auth.api.getSession({ headers: await headers() })) {
    const home = await resolveHome();
    if (home) redirect(home);
  }
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <SignInForm />
    </main>
  );
}

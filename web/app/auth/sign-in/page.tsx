import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SignInForm } from "@/components/auth/sign-in-form";
import { resolveSessionUser } from "@/lib/session-user";
import { resolveHome } from "@/lib/auth-home";

export const dynamic = "force-dynamic";

export default async function SignInPage() {
  const { user, signInUrl } = await resolveSessionUser();
  // Host-delegated orgs have no local login: the host app owns authentication.
  if (!signInUrl) {
    const h = await headers();
    const fwdHost = h.get("x-forwarded-host") ?? h.get("host") ?? "";
    if (fwdHost) {
      const proto = h.get("x-forwarded-proto") ?? "https";
      redirect(`${proto}://${fwdHost}/login`);
    }
  }
  // Already signed in? Go straight to your area.
  if (user) {
    const home = await resolveHome();
    if (home) redirect(home);
  }
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <SignInForm />
    </main>
  );
}

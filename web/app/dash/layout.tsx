import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell, ShellFallback } from "@/components/app-shell";
import { ClientOnly } from "@/components/client-only";
import { OrgAccentProvider } from "@/components/org-accent-provider";
import { OrgPin } from "@/components/org-pin";
import { auth } from "@/lib/auth";
import { getSessionOrg, studioOrgsOf } from "@/lib/org";

/**
 * The studio shell renders on the server (session gate, sidebar, accent); every page under it renders only in the
 * browser and loads its data through /api/trpc (lib/api.ts).
 */
export default async function DashLayout({ children }: { children: ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/auth/sign-in");
  const [org, orgs] = await Promise.all([getSessionOrg(), studioOrgsOf(session.user.id)]);
  return (
    <OrgAccentProvider accentColor={org?.accentColor ?? null}>
      {/* First, so this tab's requests carry its org before any page below loads data. */}
      <OrgPin orgId={org?.id ?? null} />
      <AppShell hideRoleplay={org?.hideRoleplay ?? false} orgs={orgs} orgId={org?.id ?? null}>
        <ClientOnly fallback={<ShellFallback />}>{children}</ClientOnly>
      </AppShell>
    </OrgAccentProvider>
  );
}

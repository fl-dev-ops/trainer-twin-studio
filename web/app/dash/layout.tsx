import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { ClientOnly } from "@/components/client-only";
import { OrgAccentProvider } from "@/components/org-accent-provider";
import { auth } from "@/lib/auth";
import { getSessionOrg } from "@/lib/org";
import DashLoading from "./loading";

/**
 * The studio shell renders on the server (session gate, sidebar, accent); every page under it renders only in the
 * browser and loads its data through /api/trpc (lib/api.ts).
 */
export default async function DashLayout({ children }: { children: ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/auth/sign-in");
  const org = await getSessionOrg();
  return (
    <OrgAccentProvider accentColor={org?.accentColor ?? null}>
      <AppShell hideRoleplay={org?.hideRoleplay ?? false}>
        <ClientOnly fallback={<DashLoading />}>{children}</ClientOnly>
      </AppShell>
    </OrgAccentProvider>
  );
}

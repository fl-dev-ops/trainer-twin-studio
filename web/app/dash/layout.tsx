import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { OrgAccentProvider } from "@/components/org-accent-provider";
import { auth } from "@/lib/auth";
import { getSessionOrg } from "@/lib/org";

export default async function DashLayout({ children }: { children: ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/auth/sign-in");
  const org = await getSessionOrg();
  return (
    <OrgAccentProvider accentColor={org?.accentColor ?? null}>
      <AppShell>{children}</AppShell>
    </OrgAccentProvider>
  );
}

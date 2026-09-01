import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { OrgAccentProvider } from "@/components/org-accent-provider";
import { resolveSessionUser } from "@/lib/session-user";

export default async function DashLayout({ children }: { children: ReactNode }) {
  const { org, user } = await resolveSessionUser();
  if (!user) redirect("/auth/sign-in");
  // The dash is the trainer studio; learners (role "member") have no surface here.
  if (user.role !== "admin" && user.role !== "owner") redirect("/auth/no-org");
  if (!org) redirect("/auth/no-org");
  return (
    <OrgAccentProvider accentColor={org?.accentColor ?? null}>
      <AppShell basePath={org.basePath}>{children}</AppShell>
    </OrgAccentProvider>
  );
}

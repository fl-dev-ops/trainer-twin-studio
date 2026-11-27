import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell, ShellFallback } from "@/components/app-shell";
import { BillingBanner } from "@/components/billing/billing-banner";
import { ClientOnly } from "@/components/client-only";
import { COPILOT_LAYOUT_COOKIE, COPILOT_OPEN_COOKIE, COPILOT_WIDTH_COOKIE, isCopilotLayout } from "@/components/copilot/cookies";
import { NamePrompt } from "@/components/name-prompt";
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
  const [org, orgs, jar] = await Promise.all([getSessionOrg(), studioOrgsOf(session.user.id), cookies()]);
  const copilotWidth = Number(jar.get(COPILOT_WIDTH_COOKIE)?.value);
  const copilotLayout = jar.get(COPILOT_LAYOUT_COOKIE)?.value;
  const copilot = {
    open: jar.get(COPILOT_OPEN_COOKIE)?.value === "1",
    width: Number.isFinite(copilotWidth) && copilotWidth > 0 ? copilotWidth : undefined,
    layout: isCopilotLayout(copilotLayout) ? copilotLayout : undefined,
  };
  return (
    <OrgAccentProvider accentColor={org?.accentColor ?? null}>
      {/* First, so this tab's requests carry its org before any page below loads data. */}
      <OrgPin orgId={org?.id ?? null} />
      <AppShell hideRoleplay={org?.hideRoleplay ?? false} bots={org?.bots ?? false} orgs={orgs} orgId={org?.id ?? null} copilot={copilot}>
        <ClientOnly fallback={<ShellFallback />}>
          <BillingBanner />
          <NamePrompt />
          {children}
        </ClientOnly>
      </AppShell>
    </OrgAccentProvider>
  );
}

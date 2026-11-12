"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PageContainer } from "@/components/page-container";
import { SettingsIcon } from "@/components/icons";
import { PageHeader } from "@/components/page-header";
import { OrganizationForm, ProfileForm } from "@/components/profile-form";
import { TeamSection } from "@/components/users/team-section";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useApi } from "@/lib/api";

const TABS = ["account", "team", "branding"] as const;

export default function SettingsPage() {
  const requested = useSearchParams().get("tab");
  const router = useRouter();
  const { user, organization, team } = useApi(["page.settings"], () => api.page.settings.query());
  // Billing moved to its own page; redirect old studio links, but keep learners on Account.
  useEffect(() => {
    if (requested === "billing" && team) router.replace("/billing");
  }, [requested, router, team]);
  // Learners only have Account; studio-only tabs fall back to it.
  const tab = TABS.find((name) => name === requested && (name === "account" || team)) ?? "account";
  // The URL holds the tab, so the sidebar's Settings link (no ?tab) is Account again. replaceState: no server request.
  const selectTab = (value: unknown) => window.history.replaceState(null, "", value === "account" ? "/settings" : `/settings?tab=${value}`);

  return (
    <PageContainer className="max-w-3xl">
      <PageHeader
        icon={SettingsIcon}
        title="Settings"
        description="Manage the details shown across your TrainerTwin workspace."
      />

      <Tabs value={tab} onValueChange={selectTab} className="mt-6">
        <TabsList>
          <TabsTrigger value="account">Account</TabsTrigger>
          {team ? <TabsTrigger value="team">Team</TabsTrigger> : null}
          {organization ? <TabsTrigger value="branding">Branding</TabsTrigger> : null}
        </TabsList>

        <TabsContent value="account" className="pt-8">
          <ProfileForm user={user} />
        </TabsContent>

        {team ? (
          <TabsContent value="team" className="pt-8">
            <TeamSection currentUserId={user.id} members={team.members} />
          </TabsContent>
        ) : null}

        {organization ? (
          <TabsContent value="branding" className="pt-8">
            <OrganizationForm organization={organization} />
          </TabsContent>
        ) : null}
      </Tabs>
    </PageContainer>
  );
}

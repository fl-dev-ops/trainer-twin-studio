"use client";

import { useSearchParams } from "next/navigation";
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
  const { user, organization, team } = useApi(["page.settings"], () => api.page.settings.query());
  // Learners have no Team tab, so ?tab=team falls back to Account for them.
  const tab = TABS.find((name) => name === requested && (name !== "team" || team)) ?? "account";
  // The URL holds the tab, so the sidebar's Settings link (no ?tab) is Account again. replaceState: no server request.
  const selectTab = (value: unknown) => window.history.replaceState(null, "", value === "account" ? "/settings" : `/settings?tab=${value}`);

  return (
    <PageContainer>
      <PageHeader
        className="border-b pb-6"
        icon={SettingsIcon}
        title="Settings"
        description="Manage the details shown across your TrainerTwin workspace."
      />

      <Tabs value={tab} onValueChange={selectTab} className="mt-6">
        <TabsList>
          <TabsTrigger value="account">Account</TabsTrigger>
          {team ? <TabsTrigger value="team">Team</TabsTrigger> : null}
          <TabsTrigger value="branding">Branding</TabsTrigger>
        </TabsList>

        <TabsContent value="account">
          <ProfileForm user={user} />
        </TabsContent>

        {team ? (
          <TabsContent value="team" className="pt-6">
            <TeamSection currentUserId={user.id} members={team.members} />
          </TabsContent>
        ) : null}

        <TabsContent value="branding" className="pt-3">
          <OrganizationForm organization={organization} />
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}

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

  return (
    <main className="min-h-0 flex-1 overflow-auto p-5 sm:p-8">
      <PageContainer size="narrow">
        <PageHeader
          className="border-b pb-6"
          icon={SettingsIcon}
          title="Settings"
          description="Manage the details shown across your TrainerTwin workspace."
        />

        <Tabs defaultValue={tab} className="mt-6">
          <TabsList>
            <TabsTrigger value="account">Account</TabsTrigger>
            {team ? <TabsTrigger value="team">Team</TabsTrigger> : null}
            <TabsTrigger value="branding">Branding</TabsTrigger>
          </TabsList>

          <TabsContent value="account">
            <ProfileForm user={user} />
          </TabsContent>

          {team ? (
            <TabsContent value="team">
              <TeamSection
                organizationId={organization.id}
                currentUserId={user.id}
                members={team.members}
                invitations={team.invitations}
                awaiting={team.awaiting}
              />
            </TabsContent>
          ) : null}

          <TabsContent value="branding" className="pt-3">
            <OrganizationForm organization={organization} />
          </TabsContent>
        </Tabs>
      </PageContainer>
    </main>
  );
}

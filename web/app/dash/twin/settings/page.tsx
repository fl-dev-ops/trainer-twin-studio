import { SettingsIcon } from "@/components/icons";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";

/** Twin settings — org-level twin configuration. */
export default function TwinSettingsPage() {
  return (
    <PageContainer>
      <PageHeader
        icon={SettingsIcon}
        title="Twin settings"
        description="Organization-level configuration for how your twins behave."
      />
    </PageContainer>
  );
}

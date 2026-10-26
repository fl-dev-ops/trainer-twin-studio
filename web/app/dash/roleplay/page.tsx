import { RoleplayIcon } from "@/components/icons";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";

/** Role play landing — the beta rail's "Role play" surface. */
export default function RoleplayPage() {
  return (
    <PageContainer>
      <PageHeader
        icon={RoleplayIcon}
        title="Role play"
        description="Scenarios and role play sessions for your learners."
      />
    </PageContainer>
  );
}

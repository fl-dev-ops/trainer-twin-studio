import { redirect } from "next/navigation";
import { KnowledgeView } from "@/components/knowledge";
import { getSessionOrg } from "@/lib/org";
import { OrganizationKnowledgeService } from "@/lib/org-knowledge";

export const dynamic = "force-dynamic";

export default async function KnowledgePage() {
  const org = await getSessionOrg();
  if (!org) redirect("/auth/no-org");

  const [initialDocs, initialStats] = await Promise.all([
    OrganizationKnowledgeService.getAllDocuments(org.id),
    OrganizationKnowledgeService.getStats(org.id),
  ]);

  return <KnowledgeView initialDocs={initialDocs} initialStats={initialStats} />;
}

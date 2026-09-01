import { redirect } from "next/navigation";
import { KnowledgeIndex } from "@/components/knowledge-manager";
import { getSessionOrg } from "@/lib/org";
import { listKnowledgeBases } from "@/lib/specs";

export const dynamic = "force-dynamic";

export default async function KnowledgePage() {
  const org = await getSessionOrg();
  if (!org) redirect("/auth/no-org");
  return <KnowledgeIndex bases={await listKnowledgeBases(org.id)} basePath={org.basePath} />;
}

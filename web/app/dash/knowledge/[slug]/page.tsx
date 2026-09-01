import { notFound } from "next/navigation";
import { KnowledgeDetail } from "@/components/knowledge-manager";
import { getSessionOrg } from "@/lib/org";

export default async function KnowledgeBasePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const org = await getSessionOrg();
  if (!org) notFound();
  return <KnowledgeDetail slug={decodeURIComponent(slug)} basePath={org.basePath} />;
}

import { KnowledgeDetail } from "@/components/knowledge-manager";

export default async function KnowledgeBasePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <KnowledgeDetail slug={decodeURIComponent(slug)} />;
}

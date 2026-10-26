import { TwinAgentDetailPage } from "@/components/twin/twin-agent-detail-page";
import { orNotFound, twinServer } from "@/lib/twin/server";

export const dynamic = "force-dynamic";

export default async function TwinAgentDetailRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const twin = await twinServer();
  return <TwinAgentDetailPage twin={await orNotFound(twin.agents.get({ slug: id }))} />;
}

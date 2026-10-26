import { TwinAgentDetailPage } from "@/components/twin/twin-agent-detail-page";

export default async function TwinAgentDetailRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TwinAgentDetailPage id={id} />;
}

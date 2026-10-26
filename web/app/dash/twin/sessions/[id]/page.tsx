import { TwinSessionDetailPage } from "@/components/twin/twin-session-detail-page";

export default async function TwinSessionDetailRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TwinSessionDetailPage id={id} />;
}

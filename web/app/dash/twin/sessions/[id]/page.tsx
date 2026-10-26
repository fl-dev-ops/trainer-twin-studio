import { TwinSessionDetailPage } from "@/components/twin/twin-session-detail-page";
import { orNotFound, twinServer } from "@/lib/twin/server";

export const dynamic = "force-dynamic";

export default async function TwinSessionDetailRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const twin = await twinServer();
  return <TwinSessionDetailPage session={await orNotFound(twin.sessions.get({ id }))} />;
}

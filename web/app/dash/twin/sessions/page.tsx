import { TwinSessionsPage } from "@/components/twin/twin-sessions-page";
import { twinServer } from "@/lib/twin/server";

export const dynamic = "force-dynamic";

export default async function TwinSessionsRoute() {
  const twin = await twinServer();
  return <TwinSessionsPage sessions={await twin.sessions.list()} />;
}

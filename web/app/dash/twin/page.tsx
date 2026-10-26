import { TwinAgentsPage } from "@/components/twin/twin-agents-page";
import { twinServer } from "@/lib/twin/server";

export const dynamic = "force-dynamic";

/** Twin agents — the Twin Agents library. */
export default async function TwinPage() {
  const twin = await twinServer();
  return <TwinAgentsPage data={await twin.agents.list()} />;
}

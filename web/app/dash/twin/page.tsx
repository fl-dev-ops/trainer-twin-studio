import { redirect } from "next/navigation";
import { TwinAgentsPage } from "@/components/twin/twin-agents-page";
import { getTrainerOrg } from "@/lib/org";
import { ownTwinPersona } from "@/lib/twin/avatar";
import { twinServer } from "@/lib/twin/server";

export const dynamic = "force-dynamic";

/** Twin agents — the Twin Agents library. */
export default async function TwinPage() {
  const org = await getTrainerOrg();
  if (!org) redirect("/auth/no-org");
  const twin = await twinServer();
  const [data, persona] = await Promise.all([twin.agents.list(), ownTwinPersona(org.id)]);
  return <TwinAgentsPage data={data} personaSlug={persona?.slug ?? null} />;
}

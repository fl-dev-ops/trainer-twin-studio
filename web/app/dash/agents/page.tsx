import { redirect } from "next/navigation";
import { SpecResourceIndex } from "@/components/spec-resource";
import { getTrainerOrg } from "@/lib/org";
import { listSpecSummaries } from "@/lib/specs";
import { listScenarioCards } from "@/lib/scenario-cards";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const org = await getTrainerOrg();
  if (!org) redirect("/auth/no-org");
  const [specs, cards] = await Promise.all([listSpecSummaries("agents", org.id), listScenarioCards(org.id)]);
  return <SpecResourceIndex type="agents" specs={specs} cards={cards} />;
}

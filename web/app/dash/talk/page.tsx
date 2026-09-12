import { redirect } from "next/navigation";
import { SessionView } from "@/components/session-view";
import { getSessionOrg } from "@/lib/org";
import { listAgentPersonas, listRunnableSpecs, listScenarioIntroVideos, listUploads } from "@/lib/specs";

export const dynamic = "force-dynamic";

export default async function TalkPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string }>;
}) {
  const org = await getSessionOrg();
  if (!org) redirect("/auth/no-org");
  const [personas, agents, contexts, query] = await Promise.all([
    listRunnableSpecs("personas", org.id),
    listRunnableSpecs("agents", org.id),
    listUploads(org.id),
    searchParams,
  ]);
  const orderedAgents = query.agent && agents.includes(query.agent)
    ? [query.agent, ...agents.filter((slug) => slug !== query.agent)]
    : agents;
  const agentPersonas = await listAgentPersonas(org.id, orderedAgents);
  const introVideos = await listScenarioIntroVideos(org.id, orderedAgents);
  return (
    <SessionView
      personas={personas}
      agents={orderedAgents}
      agentPersonas={agentPersonas}
      introVideos={introVideos}
      contexts={contexts.map((c) => ({ id: c.id, name: c.name, size: c.size }))}
    />
  );
}

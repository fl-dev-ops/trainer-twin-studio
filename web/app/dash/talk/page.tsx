import { redirect } from "next/navigation";
import { SessionView } from "@/components/session-view";
import { getSessionOrg } from "@/lib/org";
import { resolveSessionUser } from "@/lib/session-user";
import { listAgentContextRequired, listAgentContextUploads, listAgentNames, listAgentPersonas, listRunnableSpecs, listScenarioIntroVideos, listUploads } from "@/lib/specs";

export const dynamic = "force-dynamic";

export default async function TalkPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string }>;
}) {
  const org = await getSessionOrg();
  if (!org) redirect("/auth/no-org");
  const { user } = await resolveSessionUser();
  const [personas, agents, contexts, query] = await Promise.all([
    listRunnableSpecs("personas", org.id),
    listRunnableSpecs("agents", org.id),
    user ? listUploads(org.id, user.id) : Promise.resolve([]),
    searchParams,
  ]);
  const initialAgent = query.agent && agents.includes(query.agent) ? query.agent : agents[0];
  const [agentNames, agentPersonas, introVideos, agentContextRequired, agentContextUploads] = await Promise.all([
    listAgentNames(org.id, agents),
    listAgentPersonas(org.id, agents),
    listScenarioIntroVideos(org.id, agents),
    listAgentContextRequired(org.id, agents),
    listAgentContextUploads(org.id, agents),
  ]);
  return (
    <SessionView
      personas={personas}
      agents={agents}
      agentNames={agentNames}
      initialAgent={initialAgent}
      agentPersonas={agentPersonas}
      introVideos={introVideos}
      agentContextRequired={agentContextRequired}
      agentContextUploads={agentContextUploads}
      contexts={contexts.map((c) => ({ id: c.id, name: c.name, size: c.size }))}
    />
  );
}

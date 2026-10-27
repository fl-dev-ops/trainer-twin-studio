import { SessionView } from "@/components/session-view";
import { db } from "@/lib/db";
import { agentPhotoUrls } from "@/lib/persona-media";
import { listAgentContextRequired, listAgentContextUploads, listScenarioIntroVideos } from "@/lib/specs";

/**
 * A twin opened from a learner link (/s/<code> or /t/<path>): the voice session screen started with that code.
 * Minutes are enforced when the session starts.
 */
export async function TwinSession({ orgId, agentId, code, userName }: { orgId: string; agentId: string; code: string; userName: string }) {
  const [agent, organization] = await Promise.all([
    db.agent.findFirstOrThrow({ where: { id: agentId, orgId }, select: { slug: true, name: true, persona: { select: { slug: true } } } }),
    db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true, logo: true } }),
  ]);
  const [introVideos, agentPhotos, agentContextRequired, agentContextUploads] = await Promise.all([
    listScenarioIntroVideos(orgId, [agent.slug]),
    agentPhotoUrls(orgId, [agent.slug]),
    listAgentContextRequired(orgId, [agent.slug]),
    listAgentContextUploads(orgId, [agent.slug]),
  ]);
  const logo = organization.logo ?? "";
  return (
    <SessionView
      personas={[agent.persona.slug]}
      agents={[agent.slug]}
      scenarioName={agent.name}
      userName={userName}
      organizationName={organization.name}
      organizationLogo={/^data:image\/(?:png|jpeg|webp);base64,/.test(logo) ? logo : null}
      agentPersonas={{ [agent.slug]: agent.persona.slug }}
      agentContextRequired={agentContextRequired}
      agentContextUploads={agentContextUploads}
      introVideos={introVideos}
      agentPhotos={agentPhotos}
      autoStart
      contexts={[]}
      sessionCode={code}
    />
  );
}

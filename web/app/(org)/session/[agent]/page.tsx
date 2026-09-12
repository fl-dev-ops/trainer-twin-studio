import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { SessionView } from "@/components/session-view";
import { signInUrl } from "@/lib/base-domain";
import { getSessionOrg } from "@/lib/org";
import { listAgentPersonas, listRunnableSpecs, listScenarioIntroVideos, listUploads } from "@/lib/specs";

export const dynamic = "force-dynamic";

/** User-facing session runner: one public agent of this org, preselected. */
export default async function PortalSessionPage({
  params,
}: {
  params: Promise<{ agent: string }>;
}) {
  const host = (await headers()).get("host") ?? "";
  const orgSlug = host.split(":")[0].split(".")[0];
  const org = await getSessionOrg();
  const { agent } = await params;
  if (!org) redirect(signInUrl(host, `/session/${encodeURIComponent(agent)}`));
  const portalOrgId = (await getOrgId(orgSlug)) ?? "";

  // The agent must exist, belong to this org's portal, and be runnable.
  const agents = await listRunnableSpecs("agents", portalOrgId);
  if (!agents.includes(agent)) notFound();

  const [personas, contexts, agentPersonas] = await Promise.all([
    listRunnableSpecs("personas", portalOrgId),
    org?.id === portalOrgId ? listUploads(org.id) : Promise.resolve([]),
    listAgentPersonas(portalOrgId, [agent]),
  ]);
  if (personas.length === 0) notFound();

  const introVideos = await listScenarioIntroVideos(portalOrgId, [agent]);

  return (
    <SessionView
      personas={personas}
      agents={[agent]}
      agentPersonas={agentPersonas}
      introVideos={introVideos}
      autoStart
      contexts={contexts.map((c) => ({ id: c.id, name: c.name, size: c.size }))}
    />
  );
}

async function getOrgId(slug: string): Promise<string | null> {
  const { db } = await import("@/lib/db");
  const org = await db.organization.findUnique({ where: { slug }, select: { id: true } });
  return org?.id ?? null;
}

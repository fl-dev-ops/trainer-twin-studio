import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { SessionView } from "@/components/session-view";
import { getSessionOrg } from "@/lib/org";
import { listRunnableSpecs, listUploads } from "@/lib/specs";

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
  const portalOrgId = (await getOrgId(orgSlug)) ?? "";

  // The agent must exist, belong to this org's portal, and be runnable.
  const agents = await listRunnableSpecs("agents", portalOrgId);
  if (!agents.includes(agent)) notFound();

  const [personas, contexts] = await Promise.all([
    listRunnableSpecs("personas", portalOrgId),
    org?.id === portalOrgId ? listUploads(org.id) : Promise.resolve([]),
  ]);
  if (personas.length === 0) notFound();

  return (
    <SessionView
      personas={personas}
      agents={[agent]}
      contexts={contexts.map((c) => ({ id: c.id, name: c.name, size: c.size }))}
    />
  );
}

async function getOrgId(slug: string): Promise<string | null> {
  const { db } = await import("@/lib/db");
  const org = await db.organization.findUnique({ where: { slug }, select: { id: true } });
  return org?.id ?? null;
}

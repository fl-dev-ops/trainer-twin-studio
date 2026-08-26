import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
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

  // The agent must exist, belong to this org's portal, and be runnable.
  const agents = await listRunnableSpecs("agents", (await getOrgId(orgSlug)) ?? "");
  if (!agents.includes(agent)) notFound();

  const [personas, contexts] = await Promise.all([
    listRunnableSpecs("personas", (await getOrgId(orgSlug)) ?? ""),
    org ? listUploads(org.id) : Promise.resolve([]),
  ]);
  if (personas.length === 0) notFound();

  return (
    <main className="min-h-svh">
      <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
        <Link
          href="/"
          className="text-muted-foreground flex items-center gap-1 text-sm hover:underline"
        >
          <ArrowLeft className="size-4" /> Back to agents
        </Link>
      </div>
      <SessionView personas={personas} agents={[agent]} contexts={contexts.map((c) => ({ id: c.id, name: c.name }))} />
    </main>
  );
}

async function getOrgId(slug: string): Promise<string | null> {
  const { db } = await import("@/lib/db");
  const org = await db.organization.findUnique({ where: { slug }, select: { id: true } });
  return org?.id ?? null;
}

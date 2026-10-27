import { PersonaDetail } from "@/components/persona/persona-detail";
import { SpecResourcePage } from "@/components/spec-resource-page";
import { requireStudioMember } from "@/lib/org";
import { getPersona } from "@/lib/personas";

export const dynamic = "force-dynamic";

/** A persona's page. `?view=spec` (and global personas) open the spec page with recordings and recorded style. */
export default async function PersonaPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ version?: string; view?: string }>;
}) {
  const [{ slug }, { version, view }] = await Promise.all([params, searchParams]);
  const org = await requireStudioMember();
  const persona = view === "spec" ? null : await getPersona(org.id, slug);
  if (persona) return <PersonaDetail item={persona} />;
  return <SpecResourcePage type="personas" slug={slug} requestedVersion={version} />;
}

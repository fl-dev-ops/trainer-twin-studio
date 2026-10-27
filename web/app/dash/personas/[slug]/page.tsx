import { PersonaDetail } from "@/components/persona/persona-detail";
import { SpecResourcePage } from "@/components/spec-resource-page";
import { requireStudioMember } from "@/lib/org";
import { getRolePlayPersona } from "@/lib/personas";

export const dynamic = "force-dynamic";

/** A role-play persona's page; someone's own (or a global) persona keeps the spec page with its recordings. */
export default async function PersonaPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ version?: string }>;
}) {
  const [{ slug }, { version }] = await Promise.all([params, searchParams]);
  const org = await requireStudioMember();
  const persona = await getRolePlayPersona(org.id, slug);
  if (persona) return <PersonaDetail item={persona} />;
  return <SpecResourcePage type="personas" slug={slug} requestedVersion={version} />;
}

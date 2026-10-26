import { notFound, redirect } from "next/navigation";
import { PersonaEditor } from "@/components/client-persona/persona-editor";
import { SpecResourcePage } from "@/components/spec-resource-page";
import { formFromPersonaData } from "@/lib/client-persona";
import { listPersonaDocuments, listPersonaSources, listPersonaVoices } from "@/lib/client-persona-data";
import { db } from "@/lib/db";
import { getSessionOrg } from "@/lib/org";
import { isClientPersonaData } from "@/lib/roleplay";

export const dynamic = "force-dynamic";

export default async function PersonaPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ version?: string }>;
}) {
  const [{ slug }, { version }] = await Promise.all([params, searchParams]);
  const org = await getSessionOrg();
  if (!org) redirect("/auth/no-org");

  // Client personas (the people learners speak with in role plays) use the single-page editor.
  const persona = slug === "new"
    ? null
    : await db.persona.findUnique({ where: { orgId_slug: { orgId: org.id, slug } }, select: { data: true } });
  const isClient = slug === "new" ? org.type === "SALES" : Boolean(persona && isClientPersonaData(persona.data));
  if (!isClient) {
    if (slug === "new") notFound();
    return <SpecResourcePage type="personas" slug={slug} requestedVersion={version} />;
  }

  const initial = persona ? formFromPersonaData(persona.data) : undefined;
  const [voices, sources, documents] = await Promise.all([
    listPersonaVoices(org.id),
    listPersonaSources(org.id),
    listPersonaDocuments(org.id, initial?.knowledge.documentIds ?? []),
  ]);
  return (
    <PersonaEditor
      key={slug}
      slug={persona ? slug : undefined}
      initial={initial}
      voices={voices}
      sources={sources}
      documents={documents}
    />
  );
}

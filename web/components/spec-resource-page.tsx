import { notFound } from "next/navigation";
import yaml from "js-yaml";
import { db } from "@/lib/db";
import { AgentEditor } from "@/components/agent-editor";
import { SpecResourceEditor } from "@/components/spec-resource";
import { getTrainerOrg } from "@/lib/org";
import { readSpecDraft } from "@/lib/spec-drafts";
import { listSpecs, listVersions, readSpec, readVersion } from "@/lib/specs";

export async function SpecResourcePage({
  type,
  slug,
  requestedVersion,
  isNew = false,
}: {
  type: "personas" | "agents";
  slug: string;
  requestedVersion?: string;
  isNew?: boolean;
}) {
  const org = await getTrainerOrg();
  if (!org) notFound();
  const current = await readSpec(type, slug, org.id).catch(() => null);

  if (type === "agents") {
    const version = requestedVersion === undefined ? undefined : Number(requestedVersion);
    if (requestedVersion !== undefined && (!Number.isInteger(version) || (version as number) < 1)) notFound();
    const historical =
      current && version !== undefined && version !== current.version
        ? await readVersion(type, slug, version as number, org.id)
        : null;
    if (requestedVersion !== undefined && !current && !historical) notFound();
    if (requestedVersion !== undefined && current && version !== current.version && !historical) notFound();

    const [personas, versions] = await Promise.all([
      listSpecs("personas", org.id).then((slugs) =>
        db.persona.findMany({ where: { orgId: org.id, slug: { in: slugs.length ? slugs : ["__none__"] } }, orderBy: { slug: "asc" }, select: { slug: true, name: true } }),
      ),
      current ? listVersions(type, slug, org.id) : Promise.resolve([]),
    ]);

    if (!current) {
      if (requestedVersion !== undefined) notFound();
      const draft = isNew ? null : await readSpecDraft(slug, org.id).catch(() => null);
      if (!draft && !isNew) notFound();
      const agent = (draft?.agent ?? {}) as Record<string, unknown>;
      return (
        <AgentEditor
          key={`draft:${slug}:${draft?.revision ?? 0}`}
          slug={slug}
          instruction={typeof agent.instruction === "string" ? agent.instruction : ""}
          name={draft?.name ?? ""}
          opening={typeof agent.opening === "string" ? agent.opening : ""}
          personaSlug={draft?.personaSlug ?? ""}
          knowledgeBase={typeof agent.knowledgeBase === "string" ? agent.knowledgeBase : ""}
          voiceId={typeof agent.voiceId === "string" ? agent.voiceId : ""}
          specYaml=""
          revision={draft?.revision}
          versions={[]}
          personas={personas}
        />
      );
    }

    if (historical) {
      return (
        <SpecResourceEditor
          key={`${slug}:${current.version}:${version}`}
          type={type}
          slug={slug}
          name={typeof current.doc.name === "string" ? current.doc.name : slug}
          text={historical.text}
          currentVersion={current.version}
          shownVersion={version as number}
          versions={versions}
        />
      );
    }

    const doc = current.doc as Record<string, unknown>;
    const draft = await readSpecDraft(slug, org.id).catch(() => null);
    const working = (draft?.agent ?? doc) as Record<string, unknown>;
    return (
      <AgentEditor
        key={`current:${slug}:${current.version}:${draft?.revision ?? 0}`}
        slug={slug}
        instruction={typeof working.instruction === "string" ? working.instruction : ""}
        name={typeof working.name === "string" ? working.name : slug}
        opening={typeof working.opening === "string" ? working.opening : ""}
        personaSlug={draft?.personaSlug ?? personas[0]?.slug ?? ""}
        knowledgeBase={typeof working.knowledgeBase === "string" ? working.knowledgeBase : ""}
        voiceId={typeof working.voiceId === "string" ? working.voiceId : ""}
        specYaml={yaml.dump({ schema_version: 1, kind: "agent", agent: working, domain: draft?.domain ?? null }, { lineWidth: -1, noRefs: true })}
        revision={draft?.status === "draft" ? draft.revision : undefined}
        publishedVersion={current.version}
        versions={versions}
        personas={personas}
      />
    );
  }

  // Personas keep the YAML editor.
  if (!current) notFound();
  const version = requestedVersion === undefined ? current.version : Number(requestedVersion);
  if (!Number.isInteger(version) || version < 1) notFound();
  const historical = version === current.version ? current : await readVersion(type, slug, version, org.id);
  if (!historical) notFound();

  const persona = await db.persona.findUnique({ where: { orgId_slug: { orgId: org.id, slug } }, select: { id: true } });
  if (!persona) notFound();
  const initialSources = await db.personaSource.findMany({
    where: { personaId: persona.id, orgId: org.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, kind: true, name: true, status: true, metadata: true, createdAt: true },
  });

  return (
    <SpecResourceEditor
      key={`${slug}:${current.version}:${version}`}
      type={type}
      slug={slug}
      name={typeof current.doc.name === "string" ? current.doc.name : slug}
      text={historical.text}
      currentVersion={current.version}
      shownVersion={version}
      versions={await listVersions(type, slug, org.id)}
      sources={initialSources}
    />
  );
}

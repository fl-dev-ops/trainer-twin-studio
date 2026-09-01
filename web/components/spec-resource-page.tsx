import { notFound } from "next/navigation";
import yaml from "js-yaml";
import { SpecDraftResourceViewer, SpecResourceEditor } from "@/components/spec-resource";
import { getSessionOrg } from "@/lib/org";
import { readSpecDraft } from "@/lib/spec-drafts";
import { listVersions, readSpec, readVersion } from "@/lib/specs";

export async function SpecResourcePage({
  type,
  slug,
  requestedVersion,
}: {
  type: "personas" | "agents";
  slug: string;
  requestedVersion?: string;
}) {
  const org = await getSessionOrg();
  if (!org) notFound();
  const current = await readSpec(type, slug, org.id).catch(() => null);
  if (!current) {
    const draft = type === "agents" ? await readSpecDraft(slug).catch(() => null) : null;
    if (!draft || requestedVersion !== undefined) notFound();
    return (
      <SpecDraftResourceViewer
        slug={draft.slug}
        name={draft.name}
        revision={draft.revision}
        text={yaml.dump({ schema_version: 1, kind: "agent", agent: draft.agent }, { lineWidth: -1, noRefs: true })}
      />
    );
  }

  const version = requestedVersion === undefined ? current.version : Number(requestedVersion);
  if (!Number.isInteger(version) || version < 1) notFound();
  const historical = version === current.version ? current : await readVersion(type, slug, version, org.id);
  if (!historical) notFound();
  const name = typeof current.doc.name === "string" ? current.doc.name : slug;

  return (
    <SpecResourceEditor
      key={`${slug}:${current.version}:${version}`}
      type={type}
      slug={slug}
      name={name}
      text={historical.text}
      currentVersion={current.version}
      shownVersion={version}
      versions={await listVersions(type, slug, org.id)}
      basePath={org.basePath}
    />
  );
}

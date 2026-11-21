import { TRPCError } from "@trpc/server";
import type { ComponentProps } from "react";
import type { SpecResourceEditor } from "@/components/spec-resource";
import { db } from "@/lib/db";
import { getPersonaBaseline } from "@/lib/persona-baseline";
import { listVersions, readSpec, readVersion } from "@/lib/specs";

/** What a persona's spec page renders: the YAML spec editor, with its key. */
export type SpecResourceView = { view: "spec"; key: string; props: ComponentProps<typeof SpecResourceEditor> };

const notFound = (): never => {
  throw new TRPCError({ code: "NOT_FOUND" });
};

export async function loadSpecResource({
  orgId,
  type,
  slug,
  requestedVersion,
}: {
  orgId: string;
  type: "personas";
  slug: string;
  requestedVersion?: string;
}): Promise<SpecResourceView> {
  const current = await readSpec(type, slug, orgId).catch(() => null);
  if (!current) return notFound();
  const version = requestedVersion === undefined ? current.version : Number(requestedVersion);
  if (!Number.isInteger(version) || version < 1) notFound();
  const historical = version === current.version ? current : await readVersion(type, slug, version, orgId);
  if (!historical) return notFound();

  const persona = await db.persona.findUnique({ where: { orgId_slug: { orgId, slug } }, select: { id: true } });
  if (!persona) return notFound();
  const [initialSources, baseline, versions] = await Promise.all([
    db.personaSource.findMany({
      where: { personaId: persona.id, orgId },
      orderBy: { createdAt: "asc" },
      select: { id: true, kind: true, name: true, status: true, metadata: true, createdAt: true },
    }),
    getPersonaBaseline(orgId, slug),
    listVersions(type, slug, orgId),
  ]);

  return {
    view: "spec",
    key: `${slug}:${current.version}:${version}`,
    props: {
      type,
      slug,
      name: typeof current.doc.name === "string" ? current.doc.name : slug,
      text: historical.text,
      currentVersion: current.version,
      shownVersion: version,
      versions,
      sources: initialSources,
      baseline,
    },
  };
}

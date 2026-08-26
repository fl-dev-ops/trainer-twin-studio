import type { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { specDraftBundleSchema, type SpecDraftBundle } from "@/lib/spec-draft-schema";

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function bundleFromRow(row: {
  slug: string;
  name: string;
  personaSlug: string | null;
  agentData: unknown;
  domainData: unknown;
  groundingData: unknown;
  assumptions: unknown;
  gaps: unknown;
}): SpecDraftBundle {
  return specDraftBundleSchema.parse({
    slug: row.slug,
    name: row.name,
    personaSlug: row.personaSlug ?? undefined,
    agent: row.agentData,
    domain: row.domainData,
    grounding: row.groundingData,
    assumptions: row.assumptions,
    gaps: row.gaps,
  });
}

export async function listSpecDrafts() {
  return db.specDraft.findMany({
    orderBy: { updatedAt: "desc" },
    select: { slug: true, name: true, status: true, revision: true, updatedAt: true, publishedAt: true },
  });
}

export async function readSpecDraft(slug: string) {
  const row = await db.specDraft.findUnique({
    where: { slug },
    include: { revisions: { orderBy: { revision: "desc" }, take: 20, select: { revision: true, createdAt: true } } },
  });
  if (!row) return null;
  return {
    ...bundleFromRow(row),
    status: row.status,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
    publishedAt: row.publishedAt?.toISOString() ?? null,
    revisions: row.revisions.map((revision) => ({ ...revision, createdAt: revision.createdAt.toISOString() })),
  };
}

export async function saveSpecDraft(input: unknown) {
  const bundle = specDraftBundleSchema.parse(input);
  const existing = await db.specDraft.findUnique({ where: { slug: bundle.slug } });
  if (!existing) {
    const created = await db.specDraft.create({
      data: {
        slug: bundle.slug,
        name: bundle.name,
        personaSlug: bundle.personaSlug,
        agentData: json(bundle.agent),
        domainData: json(bundle.domain),
        groundingData: json(bundle.grounding),
        assumptions: json(bundle.assumptions),
        gaps: json(bundle.gaps),
      },
    });
    return { ...bundle, status: created.status, revision: created.revision, changed: true };
  }

  const current = bundleFromRow(existing);
  if (JSON.stringify(current) === JSON.stringify(bundle)) {
    return { ...bundle, status: existing.status, revision: existing.revision, changed: false };
  }

  const revision = existing.revision + 1;
  await db.$transaction([
    db.specDraftRevision.create({
      data: { draftId: existing.id, revision: existing.revision, data: json(current) },
    }),
    db.specDraft.update({
      where: { id: existing.id },
      data: {
        name: bundle.name,
        personaSlug: bundle.personaSlug,
        agentData: json(bundle.agent),
        domainData: json(bundle.domain),
        groundingData: json(bundle.grounding),
        assumptions: json(bundle.assumptions),
        gaps: json(bundle.gaps),
        status: "draft",
        revision,
      },
    }),
  ]);
  return { ...bundle, status: "draft", revision, changed: true };
}

export async function publishSpecDraft(slug: string) {
  const row = await db.specDraft.findUnique({ where: { slug } });
  if (!row) throw new Error(`Draft "${slug}" was not found`);
  const bundle = bundleFromRow(row);
  if (bundle.gaps.length) throw new Error(`Resolve ${bundle.gaps.length} draft gap(s) before publishing`);

  const [persona, knowledgeBases] = await Promise.all([
    bundle.personaSlug ? db.persona.findUnique({ where: { slug: bundle.personaSlug }, select: { id: true } }) : Promise.resolve(null),
    db.knowledgeBase.findMany({
      where: { slug: { in: bundle.domain.knowledge_bases }, documents: { some: { status: "indexed" } } },
      select: { slug: true },
    }),
  ]);
  if (bundle.personaSlug && !persona) throw new Error(`Persona "${bundle.personaSlug}" was not found`);
  const indexed = new Set(knowledgeBases.map(({ slug }) => slug));
  const missing = bundle.domain.knowledge_bases.filter((kb) => !indexed.has(kb));
  if (missing.length) throw new Error(`Knowledge bases are missing or not indexed: ${missing.join(", ")}`);

  const domainData = bundle.domain;
  const agentData = { ...bundle.agent, knowledge_grounding: bundle.grounding };
  const result = await db.$transaction(async (tx) => {
    const currentDomain = await tx.domain.findUnique({ where: { slug: bundle.domain.id } });
    let domainVersion = currentDomain?.version ?? 1;
    if (!currentDomain) {
      await tx.domain.create({ data: { slug: bundle.domain.id, name: bundle.domain.name, version: 1, data: json(domainData) } });
    } else if (JSON.stringify(currentDomain.data) !== JSON.stringify(domainData)) {
      domainVersion += 1;
      await tx.specVersion.create({ data: { entityType: "domains", entitySlug: currentDomain.slug, version: currentDomain.version, data: json(currentDomain.data) } });
      await tx.domain.update({ where: { id: currentDomain.id }, data: { name: bundle.domain.name, version: domainVersion, data: json(domainData) } });
    }

    const currentAgent = await tx.agent.findUnique({ where: { slug: bundle.agent.id } });
    let agentVersion = currentAgent?.version ?? 1;
    if (!currentAgent) {
      await tx.agent.create({ data: { slug: bundle.agent.id, name: bundle.agent.name, version: 1, domainSlug: bundle.domain.id, data: json(agentData) } });
    } else if (JSON.stringify(currentAgent.data) !== JSON.stringify(agentData)) {
      agentVersion += 1;
      await tx.specVersion.create({ data: { entityType: "agents", entitySlug: currentAgent.slug, version: currentAgent.version, data: json(currentAgent.data) } });
      await tx.agent.update({ where: { id: currentAgent.id }, data: { name: bundle.agent.name, version: agentVersion, domainSlug: bundle.domain.id, data: json(agentData) } });
    }

    await tx.specDraft.update({ where: { id: row.id }, data: { status: "published", publishedAt: new Date() } });
    return { agentVersion, domainVersion };
  });

  return { slug, status: "published" as const, ...result };
}

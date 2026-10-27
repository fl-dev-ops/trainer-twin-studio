import type { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { specDraftBundleSchema, type SpecDraftBundle } from "@/lib/spec-draft-schema";
import { findOrgOrGlobalPersona } from "@/lib/specs";

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function bundleFromRow(row: {
  slug: string;
  name: string;
  personaSlug: string | null;
  agentData: unknown;
  groundingData: unknown;
  assumptions: unknown;
  gaps: unknown;
}): SpecDraftBundle {
  return specDraftBundleSchema.parse({
    slug: row.slug,
    name: row.name,
    personaSlug: row.personaSlug ?? undefined,
    agent: row.agentData,
    grounding: row.groundingData,
    assumptions: row.assumptions,
    gaps: row.gaps,
  });
}

export async function listSpecDrafts(orgId: string) {
  return db.specDraft.findMany({
    where: { orgId },
    orderBy: { updatedAt: "desc" },
    select: { slug: true, name: true, status: true, revision: true, updatedAt: true, publishedAt: true },
  });
}

export async function readSpecDraft(slug: string, orgId: string) {
  const row = await db.specDraft.findFirst({
    where: { slug, orgId },
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

export async function saveSpecDraft(input: unknown, orgId: string) {
  const bundle = specDraftBundleSchema.parse(input);
  const existing = await db.specDraft.findUnique({ where: { slug: bundle.slug } });
  if (existing?.orgId && existing.orgId !== orgId) {
    throw new Error("Draft belongs to another organization");
  }
  if (!existing) {
    const created = await db.specDraft.create({
      data: {
        slug: bundle.slug,
        name: bundle.name,
        personaSlug: bundle.personaSlug,
        agentData: json(bundle.agent),
        groundingData: json(bundle.grounding),
        assumptions: json(bundle.assumptions),
        gaps: json(bundle.gaps),
        // Drafts are role plays (copilot, generate route); twins come only from scenario ingest.
        kind: "ROLEPLAY",
        orgId,
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
        groundingData: json(bundle.grounding),
        assumptions: json(bundle.assumptions),
        gaps: json(bundle.gaps),
        status: "draft",
        revision,
        orgId,
      },
    }),
  ]);
  return { ...bundle, status: "draft", revision, changed: true };
}

export async function publishSpecDraft(slug: string, orgId: string) {
  const row = await db.specDraft.findFirst({ where: { slug, orgId } });
  if (!row) throw new Error(`Draft "${slug}" was not found`);
  const bundle = bundleFromRow(row);
  if (bundle.gaps.length) throw new Error(`Resolve ${bundle.gaps.length} draft gap(s) before publishing`);
  const requestedKnowledge = [...new Set([
    ...bundle.agent.knowledge_bases,
    ...(bundle.agent.knowledgeBase ? [bundle.agent.knowledgeBase] : []),
  ])];

  const [persona, knowledgeBases] = await Promise.all([
    bundle.personaSlug
      ? findOrgOrGlobalPersona(orgId, bundle.personaSlug, { id: true })
      : Promise.resolve(null),
    db.knowledgeBase.findMany({
      where: {
        orgId,
        slug: { in: requestedKnowledge },
        documents: { some: { status: "indexed" } },
      },
      select: { slug: true },
    }),
  ]);
  if (bundle.personaSlug && !persona) throw new Error(`Persona "${bundle.personaSlug}" was not found`);
  const indexed = new Set(knowledgeBases.map(({ slug }) => slug));
  const missing = requestedKnowledge.filter((kb) => !indexed.has(kb));
  if (missing.length) throw new Error(`Knowledge bases are missing or not indexed: ${missing.join(", ")}`);

  const result = await db.$transaction(async (tx) => {
    const currentAgent = await tx.agent.findUnique({ where: { slug: bundle.agent.id } });
    if (currentAgent && currentAgent.orgId !== orgId) throw new Error("Agent belongs to another organization");
    if (currentAgent && currentAgent.kind !== row.kind) throw new Error(`"${currentAgent.slug}" is a ${currentAgent.kind.toLowerCase()}, not a ${row.kind.toLowerCase()}`);
    // The intro video is provisioned operationally, not generated by the spec builder,
    // so a republish carries an existing one forward instead of dropping it.
    const previousVideo = (currentAgent?.data as { introVideo?: unknown } | null | undefined)?.introVideo;
    const agentData = {
      ...bundle.agent,
      knowledge_grounding: bundle.grounding,
      ...(typeof previousVideo === "string" ? { introVideo: previousVideo } : {}),
    };
    let agentVersion = currentAgent?.version ?? 1;
    if (!persona) throw new Error("A published agent requires a persona");
    if (!currentAgent) {
      await tx.agent.create({ data: { slug: bundle.agent.id, name: bundle.agent.name, version: 1, personaId: persona.id, kind: row.kind, data: json(agentData), orgId } });
    } else if (JSON.stringify(currentAgent.data) !== JSON.stringify(agentData) || currentAgent.personaId !== persona.id) {
      agentVersion += 1;
      await tx.specVersion.create({ data: { entityType: "agents", entitySlug: currentAgent.slug, version: currentAgent.version, data: json(currentAgent.data), orgId } });
      await tx.agent.update({ where: { id: currentAgent.id }, data: { name: bundle.agent.name, version: agentVersion, personaId: persona.id, data: json(agentData), orgId } });
    }

    await tx.specDraft.update({ where: { id: row.id }, data: { status: "published", publishedAt: new Date() } });
    return { agentVersion };
  });

  return { slug, status: "published" as const, ...result };
}

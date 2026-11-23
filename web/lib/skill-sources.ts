import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";

/**
 * Which knowledge base documents built an immutable skill package (legacy versions use SkillSource rows): written from
 * items.json (each item's metadata.source is the KnowledgeDocument id the copilot synced it from), read by the skill
 * page ("Built from") and the knowledge base document ("Used in").
 */

/** Items per source document id, from a published items.json. */
export function countSources(items: unknown[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const source = (item as { metadata?: { source?: unknown } } | null)?.metadata?.source;
    if (typeof source === "string" && source) counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  return counts;
}

/**
 * The rows for one version: only sources that are this org's knowledge base documents (older skills cite ids from before
 * the knowledge base sync; they get no rows and show "not recorded"), titled as they are now.
 */
export async function skillSourceRows(orgId: string, agentId: string, version: number, items: unknown[], client: Pick<typeof db, "knowledgeDocument"> = db) {
  const counts = countSources(items);
  if (!counts.size) return [];
  const docs = await client.knowledgeDocument.findMany({ where: { id: { in: [...counts.keys()] }, kb: { orgId } }, select: { id: true, title: true } });
  return docs.map((doc) => ({ agentId, version, documentId: doc.id, orgId, title: doc.title, items: counts.get(doc.id)! }));
}

export type BuiltFrom = { documentId: string; title: string; items: number; /** Still in the knowledge base. */ exists: boolean }[];

/**
 * What these skill versions were built from, merged by document (the main twin passes all its live skills); most items
 * first. Null when none of them has recorded sources.
 */
type SourceClient = Pick<Prisma.TransactionClient, "agentSkillVersion" | "skillVersionSource" | "skillSource" | "knowledgeDocument">;

export async function builtFrom(orgId: string, versions: { agentId: string; version: number }[], client: SourceClient = db): Promise<BuiltFrom | null> {
  if (!versions.length) return null;
  const mappings = await client.agentSkillVersion.findMany({
    where: { orgId, agent: { orgId }, version: { skill: { orgId } }, OR: versions.map(({ agentId, version }) => ({ agentId, agentVersion: version })) },
    select: { agentId: true, agentVersion: true, skillVersionId: true },
  });
  const unmapped = versions.filter(({ agentId, version }) => !mappings.some((mapping) => mapping.agentId === agentId && mapping.agentVersion === version));
  const [mappedRows, legacyRows] = await Promise.all([
    mappings.length ? client.skillVersionSource.findMany({
      where: { orgId, skillVersionId: { in: [...new Set(mappings.map((mapping) => mapping.skillVersionId))] }, version: { skill: { orgId } } },
      select: { documentId: true, title: true, items: true },
    }) : [],
    unmapped.length ? client.skillSource.findMany({
      where: { orgId, agent: { orgId }, OR: unmapped },
      select: { documentId: true, title: true, items: true },
    }) : [],
  ]);
  const rows = [...mappedRows, ...legacyRows];
  if (!rows.length) return null;
  const merged = new Map<string, { documentId: string; title: string; items: number }>();
  for (const row of rows) {
    const seen = merged.get(row.documentId);
    if (seen) seen.items += row.items;
    else merged.set(row.documentId, { documentId: row.documentId, title: row.title, items: row.items });
  }
  const live = await client.knowledgeDocument.findMany({ where: { id: { in: [...merged.keys()] }, kb: { orgId } }, select: { id: true, title: true } });
  const now = new Map(live.map((doc) => [doc.id, doc.title]));
  return [...merged.values()]
    .map((row) => ({ ...row, title: now.get(row.documentId) ?? row.title, exists: now.has(row.documentId) }))
    .sort((a, b) => b.items - a.items || a.title.localeCompare(b.title));
}

/** The skills / role plays whose live version uses this document (archived ones left out), most items first. */
export async function usedIn(orgId: string, documentId: string, client: SourceClient = db) {
  const mappings = await client.agentSkillVersion.findMany({
    where: { orgId, agent: { orgId, archivedAt: null }, version: { skill: { orgId } } },
    select: { agentId: true, agentVersion: true, skillVersionId: true, agent: { select: { slug: true, name: true, kind: true, version: true } } },
  });
  const current = mappings.filter((mapping) => mapping.agentVersion === mapping.agent.version);
  const sources = current.length ? await client.skillVersionSource.findMany({
    where: { orgId, documentId, skillVersionId: { in: [...new Set(current.map((mapping) => mapping.skillVersionId))] }, version: { skill: { orgId } } },
    select: { skillVersionId: true, items: true },
  }) : [];
  const rows = await client.skillSource.findMany({
    where: { orgId, documentId, agent: { orgId, archivedAt: null } },
    select: { version: true, items: true, agent: { select: { slug: true, name: true, kind: true, version: true } } },
  });
  return [
    ...current.flatMap((mapping) => sources.filter((source) => source.skillVersionId === mapping.skillVersionId).map((source) => ({ version: mapping.agentVersion, items: source.items, agent: mapping.agent }))),
    ...rows.filter((row) => row.version === row.agent.version && !current.some((mapping) => mapping.agent.slug === row.agent.slug)),
  ]
    .map((row) => ({ slug: row.agent.slug, name: row.agent.name, kind: row.agent.kind === "TWIN" ? "twin" as const : "roleplay" as const, version: row.version, items: row.items }))
    .sort((a, b) => b.items - a.items || a.name.localeCompare(b.name));
}

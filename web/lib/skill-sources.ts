import { db } from "@/lib/db";

/**
 * Which knowledge base documents built a twin skill / role play version (SkillSource rows): written at publish from
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
export async function builtFrom(orgId: string, versions: { agentId: string; version: number }[]): Promise<BuiltFrom | null> {
  if (!versions.length) return null;
  const rows = await db.skillSource.findMany({
    where: { orgId, OR: versions.map(({ agentId, version }) => ({ agentId, version })) },
    select: { documentId: true, title: true, items: true },
  });
  if (!rows.length) return null;
  const merged = new Map<string, { documentId: string; title: string; items: number }>();
  for (const row of rows) {
    const seen = merged.get(row.documentId);
    if (seen) seen.items += row.items;
    else merged.set(row.documentId, { documentId: row.documentId, title: row.title, items: row.items });
  }
  const live = await db.knowledgeDocument.findMany({ where: { id: { in: [...merged.keys()] }, kb: { orgId } }, select: { id: true, title: true } });
  const now = new Map(live.map((doc) => [doc.id, doc.title]));
  return [...merged.values()]
    .map((row) => ({ ...row, title: now.get(row.documentId) ?? row.title, exists: now.has(row.documentId) }))
    .sort((a, b) => b.items - a.items || a.title.localeCompare(b.title));
}

/** The skills / role plays whose live version uses this document (archived ones left out), most items first. */
export async function usedIn(orgId: string, documentId: string) {
  const rows = await db.skillSource.findMany({
    where: { orgId, documentId, agent: { archivedAt: null } },
    select: { version: true, items: true, agent: { select: { slug: true, name: true, kind: true, version: true } } },
  });
  return rows
    .filter((row) => row.version === row.agent.version)
    .map((row) => ({ slug: row.agent.slug, name: row.agent.name, kind: row.agent.kind === "TWIN" ? "twin" as const : "roleplay" as const, version: row.version, items: row.items }))
    .sort((a, b) => b.items - a.items || a.name.localeCompare(b.name));
}

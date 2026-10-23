import { db } from "@/lib/db";

export type PersonaVoiceOption = { id: string; name: string; description: string; group: "yours" | "female" | "male" | "other" };
export type PersonaSourceOption = { id: string; label: string; detail: string; status: string };
export type PersonaDocument = { id: string; title: string; status: string };

// Built-in sample voices have no gender or accent in the database.
const SAMPLE_VOICES: Record<string, { group: "female" | "male"; description: string }> = {
  "charlotte-sample": { group: "female", description: "Sample voice" },
  "olivia-sample": { group: "female", description: "Sample voice" },
  "priya-sample": { group: "female", description: "Sample voice" },
  "oliver-sample": { group: "male", description: "Sample voice" },
  "ethan-sample": { group: "male", description: "Sample voice" },
};

const title = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

export async function listPersonaVoices(orgId: string): Promise<PersonaVoiceOption[]> {
  const voices = await db.voice.findMany({
    where: { status: "ready", OR: [{ orgId }, { orgId: null }] },
    orderBy: { name: "asc" },
    select: { id: true, name: true, orgId: true },
  });
  return voices.map((voice) => {
    if (voice.orgId) return { id: voice.id, name: voice.name, description: "Your cloned voice", group: "yours" as const };
    const sample = SAMPLE_VOICES[voice.id];
    return { id: voice.id, name: title(voice.name), description: sample?.description ?? "Sample voice", group: sample?.group ?? "other" };
  });
}

const CONNECTOR_LABEL: Record<string, string> = {
  notion: "Notion",
  notion_public: "Notion page",
  youtube: "YouTube",
};

/** Connected knowledge sources a persona can draw on (uploads are attached per document instead). */
export async function listPersonaSources(orgId: string): Promise<PersonaSourceOption[]> {
  const sources = await db.knowledgeSource.findMany({
    where: { orgId, connector: { not: "upload" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, connector: true, sourceUrl: true, status: true, _count: { select: { documents: true } } },
  });
  return sources.map((source) => ({
    id: source.id,
    label: CONNECTOR_LABEL[source.connector] ?? source.connector,
    detail: `${source.sourceUrl.replace(/^https?:\/\//, "").slice(0, 60)} · ${source._count.documents} item${source._count.documents === 1 ? "" : "s"}`,
    status: source.status,
  }));
}

export async function listPersonaDocuments(orgId: string, ids: string[]): Promise<PersonaDocument[]> {
  if (!ids.length) return [];
  const docs = await db.knowledgeDocument.findMany({
    where: { id: { in: ids }, kb: { orgId } },
    select: { id: true, title: true, status: true },
  });
  return ids.flatMap((id) => docs.filter((doc) => doc.id === id));
}

/** The indexed documents a client persona draws on: its uploads plus everything in its switched-on sources. */
export async function personaKnowledgeDocIds(orgId: string, personaData: unknown): Promise<string[]> {
  const knowledge = (personaData as { knowledge?: { documentIds?: unknown; sourceIds?: unknown } } | null)?.knowledge;
  const documentIds = Array.isArray(knowledge?.documentIds) ? knowledge.documentIds.filter((id): id is string => typeof id === "string") : [];
  const sourceIds = Array.isArray(knowledge?.sourceIds) ? knowledge.sourceIds.filter((id): id is string => typeof id === "string") : [];
  if (!documentIds.length && !sourceIds.length) return [];
  const docs = await db.knowledgeDocument.findMany({
    where: {
      kb: { orgId },
      status: "indexed",
      OR: [{ id: { in: documentIds } }, ...(sourceIds.length ? [{ sourceId: { in: sourceIds } }] : [])],
    },
    select: { id: true },
  });
  return docs.map((doc) => doc.id);
}

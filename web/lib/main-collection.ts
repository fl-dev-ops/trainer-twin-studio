import type { Collection, EmbeddingFunction, Where } from "chromadb";
import { ChromaTenantService, isSharedScope } from "@/lib/chroma-tenant";
import { embedTexts } from "@/lib/knowledge";
import type { PersonaVoiceMoment } from "@/lib/persona-voice";

export const openRouterEmbeddings: EmbeddingFunction = {
  generate: embedTexts,
  generateForQueries: embedTexts,
  defaultSpace: () => "cosine",
  supportedSpaces: () => ["cosine"],
};

export type KnowledgeMetadata = {
  type: "knowledge";
  orgId: string;
  kbId: string;
  docId: string;
  source: string;
  title?: string;
  chunkIndex: number;
};

export type PersonaVoiceMetadata = {
  type: "persona_voice";
  orgId: string;
  personaId: string;
  sourceId: string;
  sourceName: string;
  momentIndex: number;
  action?: string;
  learnerState?: string;
  move?: string;
  candidateContext?: string;
};

export type MainCollectionMetadata = KnowledgeMetadata | PersonaVoiceMetadata;

export class MainCollectionService {
  /**
   * Resolves collection name for the org.
   * - In dedicated mode (self-hosted or enterprise Chroma): "main" (isolated by tenant/database).
   * - In shared mode (standard Chroma Cloud): `org_<orgId>_main` to prevent inter-org collision.
   */
  static getCollectionName(orgId: string, isSharedFallback = false): string {
    return isSharedFallback ? `org_${orgId.replace(/[^a-zA-Z0-9_-]/g, "_")}_main` : "main";
  }

  /**
   * Gets or creates the `main` collection for an organization.
   */
  static async getCollection(orgId: string): Promise<Collection> {
    const client = await ChromaTenantService.getClient(orgId);
    const isSharedFallback = isSharedScope(client.database);
    const name = this.getCollectionName(orgId, isSharedFallback);

    return client.getOrCreateCollection({
      name,
      embeddingFunction: openRouterEmbeddings,
      configuration: {
        hnsw: { space: "cosine", ef_construction: 200, ef_search: 200, max_neighbors: 24 },
      },
    });
  }

  /**
   * Ingests knowledge chunks for one document into the organization's main collection.
   * Idempotent per docId.
   */
  static async ingestKnowledgeDoc(
    orgId: string,
    kbId: string,
    docId: string,
    source: string,
    title: string,
    chunks: string[],
  ): Promise<number> {
    const collection = await this.getCollection(orgId);

    // Delete any existing chunks for this document
    try {
      await collection.delete({
        where: {
          $and: [{ type: "knowledge" }, { docId }],
        } as Where,
      });
    } catch {
      // Collection may be new or doc may not exist yet
    }

    if (chunks.length === 0) return 0;

    const embeddings = await embedTexts(chunks);

    for (let i = 0; i < chunks.length; i += 5000) {
      const batchDocs = chunks.slice(i, i + 5000);
      const batchEmbeddings = embeddings.slice(i, i + 5000);
      const batchIds = batchDocs.map((_, j) => `kb_${docId}#${i + j}`);
      const batchMetadatas: KnowledgeMetadata[] = batchDocs.map((_, j) => ({
        type: "knowledge",
        orgId,
        kbId,
        docId,
        source,
        title,
        chunkIndex: i + j,
      }));

      await collection.upsert({
        ids: batchIds,
        embeddings: batchEmbeddings,
        documents: batchDocs,
        metadatas: batchMetadatas,
      });
    }

    return chunks.length;
  }

  /**
   * Removes all knowledge chunks for a document from the organization's main collection.
   */
  static async removeKnowledgeDoc(orgId: string, docId: string): Promise<void> {
    try {
      const collection = await this.getCollection(orgId);
      await collection.delete({
        where: {
          $and: [{ type: "knowledge" }, { docId }],
        } as Where,
      });
    } catch {
      // deletion proceeds regardless
    }
  }

  /**
   * Removes all knowledge chunks for an entire knowledge base.
   */
  static async removeKnowledgeBase(orgId: string, kbId: string): Promise<void> {
    try {
      const collection = await this.getCollection(orgId);
      await collection.delete({
        where: {
          $and: [{ type: "knowledge" }, { kbId }],
        } as Where,
      });
    } catch {
      // deletion proceeds regardless
    }
  }

  /**
   * Ingests extracted persona voice moments into the organization's main collection.
   * Idempotent per sourceId.
   */
  static async ingestPersonaVoice(
    orgId: string,
    personaId: string,
    sourceId: string,
    sourceName: string,
    moments: Array<string | PersonaVoiceMoment>,
  ): Promise<number> {
    const collection = await this.getCollection(orgId);

    try {
      await collection.delete({
        where: {
          $and: [{ type: "persona_voice" }, { sourceId }],
        } as Where,
      });
    } catch {
      // Ignore if not present
    }

    const records: PersonaVoiceMoment[] = moments.map((moment) =>
      typeof moment === "string" ? { text: moment } : moment,
    );
    if (records.length === 0) return 0;

    const embeddings = await embedTexts(records.map((moment) => moment.text));

    for (let i = 0; i < records.length; i += 5000) {
      const batchDocs = records.slice(i, i + 5000);
      const batchEmbeddings = embeddings.slice(i, i + 5000);
      const batchIds = batchDocs.map((_, j) => `persona_${sourceId}#${i + j}`);
      const batchMetadatas: PersonaVoiceMetadata[] = batchDocs.map((moment, j) => ({
        type: "persona_voice",
        orgId,
        personaId,
        sourceId,
        sourceName,
        momentIndex: i + j,
        ...(moment.action ? { action: moment.action } : {}),
        ...(moment.learnerState ? { learnerState: moment.learnerState } : {}),
        ...(moment.move ? { move: moment.move } : {}),
        ...(moment.candidateContext ? { candidateContext: moment.candidateContext } : {}),
      }));

      await collection.upsert({
        ids: batchIds,
        embeddings: batchEmbeddings,
        documents: batchDocs.map((moment) => moment.text),
        metadatas: batchMetadatas,
      });
    }

    return records.length;
  }

  /**
   * Removes persona voice moments for one source.
   */
  static async removePersonaSource(orgId: string, sourceId: string): Promise<void> {
    try {
      const collection = await this.getCollection(orgId);
      await collection.delete({
        where: {
          $and: [{ type: "persona_voice" }, { sourceId }],
        } as Where,
      });
    } catch {
      // Ignore if not present
    }
  }

  /**
   * Removes all persona voice moments for an entire persona.
   */
  static async removePersona(orgId: string, personaId: string): Promise<void> {
    try {
      const collection = await this.getCollection(orgId);
      await collection.delete({
        where: {
          $and: [{ type: "persona_voice" }, { personaId }],
        } as Where,
      });
    } catch {
      // Ignore if not present
    }
  }

  /**
   * Searches knowledge documents in the organization's main collection.
   */
  static async searchKnowledge(
    orgId: string,
    query: string,
    options: { kbIds?: string[]; limit?: number } = {},
  ): Promise<{ id: string; docId: string; kbId: string; source: string; text: string; score: number }[]> {
    const collection = await this.getCollection(orgId);
    const limit = options.limit ?? 5;
    const [queryEmbedding] = await embedTexts([query]);

    let whereFilter: Where = { type: "knowledge" };
    if (options.kbIds && options.kbIds.length === 1) {
      whereFilter = { $and: [{ type: "knowledge" }, { kbId: options.kbIds[0] }] } as Where;
    } else if (options.kbIds && options.kbIds.length > 1) {
      whereFilter = { $and: [{ type: "knowledge" }, { kbId: { $in: options.kbIds } }] } as Where;
    }

    const res = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: limit,
      where: whereFilter,
      include: ["documents", "metadatas", "distances"],
    });

    const hits: { id: string; docId: string; kbId: string; source: string; text: string; score: number }[] = [];
    const ids = res.ids?.[0] ?? [];
    const docs = res.documents?.[0] ?? [];
    const metadatas = (res.metadatas?.[0] ?? []) as Record<string, unknown>[];
    const distances = res.distances?.[0] ?? [];

    for (let i = 0; i < ids.length; i++) {
      const meta = metadatas[i] ?? {};
      const dist = distances ? distances[i] : null;
      hits.push({
        id: ids[i],
        docId: String(meta.docId ?? ids[i]),
        kbId: String(meta.kbId ?? ""),
        source: String(meta.source ?? ""),
        text: docs[i] ?? "",
        score: dist !== null && dist !== undefined ? 1 - dist : 0,
      });
    }

    return hits;
  }

  /**
   * Searches persona voice moments in the organization's main collection.
   */
  static async searchPersonaVoice(
    orgId: string,
    query: string,
    options: { personaId?: string; action?: string; learnerState?: string; move?: string; limit?: number } = {},
  ): Promise<{ id: string; personaId: string; sourceId: string; text: string; score: number; action?: string; learnerState?: string; move?: string }[]> {
    const collection = await this.getCollection(orgId);
    const limit = options.limit ?? 4;
    const [queryEmbedding] = await embedTexts([query]);

    const run = async (filters: { action?: string; learnerState?: string; move?: string }) => {
      const conditions: Where[] = [{ type: "persona_voice" }];
      if (options.personaId) conditions.push({ personaId: options.personaId });
      if (filters.action) conditions.push({ action: filters.action });
      if (filters.learnerState) conditions.push({ learnerState: filters.learnerState });
      if (filters.move) conditions.push({ move: filters.move });
      const whereClause: Where = conditions.length > 1 ? ({ $and: conditions } as Where) : conditions[0];
      const res = await collection.query({
        queryEmbeddings: [queryEmbedding],
        nResults: limit,
        where: whereClause,
        include: ["documents", "metadatas", "distances"],
      });
      const hits: { id: string; personaId: string; sourceId: string; text: string; score: number; action?: string; learnerState?: string; move?: string }[] = [];
      const ids = res.ids?.[0] ?? [];
      const docs = res.documents?.[0] ?? [];
      const metadatas = (res.metadatas?.[0] ?? []) as Record<string, unknown>[];
      const distances = res.distances?.[0] ?? [];
      for (let i = 0; i < ids.length; i++) {
        const meta = metadatas[i] ?? {};
        const dist = distances ? distances[i] : null;
        hits.push({
          id: ids[i],
          personaId: String(meta.personaId ?? ""),
          sourceId: String(meta.sourceId ?? ""),
          text: docs[i] ?? "",
          score: dist !== null && dist !== undefined ? 1 - dist : 0,
          action: typeof meta.action === "string" ? meta.action : undefined,
          learnerState: typeof meta.learnerState === "string" ? meta.learnerState : undefined,
          move: typeof meta.move === "string" ? meta.move : undefined,
        });
      }
      return hits;
    };

    const filtered = await run({
      action: options.action,
      learnerState: options.learnerState,
      move: options.move,
    });
    if (filtered.length > 0 || (!options.action && !options.learnerState && !options.move)) return filtered;
    return run({});
  }
}

import type { Collection } from "chromadb";
import { ChromaTenantService } from "@/lib/chroma-tenant";
import { openRouterEmbeddings } from "@/lib/main-collection";
import { embedTexts } from "@/lib/knowledge";

export class LearnerMemoryService {
  /**
   * Resolves the learner's collection name inside the organization database.
   */
  static getCollectionName(userId: string): string {
    return `learner_${userId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  }

  /**
   * Lazily gets or creates the learner collection in the org tenant.
   */
  static async getCollection(orgId: string, userId: string): Promise<Collection> {
    const client = await ChromaTenantService.getClient(orgId);
    const name = this.getCollectionName(userId);

    return client.getOrCreateCollection({
      name,
      embeddingFunction: openRouterEmbeddings,
      configuration: {
        hnsw: { space: "cosine", ef_construction: 200, ef_search: 200, max_neighbors: 24 },
      },
    });
  }

  /**
   * Stores a learner insight or session turn memory.
   */
  static async addMemory(
    orgId: string,
    userId: string,
    memoryId: string,
    text: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const collection = await this.getCollection(orgId, userId);
    const [embedding] = await embedTexts([text]);

    await collection.upsert({
      ids: [memoryId],
      embeddings: [embedding],
      documents: [text],
      metadatas: [{ ...metadata, orgId, userId, createdAt: new Date().toISOString() }],
    });
  }

  /**
   * Queries relevant learner memory chunks.
   */
  static async queryMemory(
    orgId: string,
    userId: string,
    query: string,
    limit = 5,
  ): Promise<{ id: string; text: string; metadata: Record<string, unknown>; score: number }[]> {
    const collection = await this.getCollection(orgId, userId);
    const [queryEmbedding] = await embedTexts([query]);

    const res = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: limit,
      include: ["documents", "metadatas", "distances"],
    });

    const hits: { id: string; text: string; metadata: Record<string, unknown>; score: number }[] = [];
    const ids = res.ids?.[0] ?? [];
    const docs = res.documents?.[0] ?? [];
    const metadatas = (res.metadatas?.[0] ?? []) as Record<string, unknown>[];
    const distances = res.distances?.[0] ?? [];

    for (let i = 0; i < ids.length; i++) {
      const dist = distances ? distances[i] : null;
      hits.push({
        id: ids[i],
        text: docs[i] ?? "",
        metadata: metadatas[i] ?? {},
        score: dist !== null && dist !== undefined ? 1 - dist : 0,
      });
    }

    return hits;
  }

  /**
   * Deletes a learner's collection.
   */
  static async deleteCollection(orgId: string, userId: string): Promise<void> {
    const client = await ChromaTenantService.getClient(orgId);
    const name = this.getCollectionName(userId);

    try {
      await client.deleteCollection({ name });
    } catch {
      // Ignore if not present
    }
  }
}

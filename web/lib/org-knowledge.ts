import type { Where } from "chromadb";
import { db } from "@/lib/db";
import { ChromaTenantService } from "@/lib/chroma-tenant";
import { MainCollectionService } from "@/lib/main-collection";
import { chunkMarkdown } from "@/lib/knowledge";
import { deletePrefix, getObjectText, kbPrefix, presignedGetUrl, putObject } from "@/lib/s3";
import { documentToMarkdown } from "@/lib/documents";
import { enqueueIngestionWork } from "@/lib/ingestion-queue";

export type OrgKnowledgeDoc = {
  id: string;
  kbId: string;
  kbSlug: string;
  slug: string;
  title: string;
  ext: string;
  size: number;
  status: string;
  error: string | null;
  chunkCount?: number;
  sourceId?: string | null;
  externalId?: string | null;
  sourceUrl?: string | null;
  connector?: string;
  sourceStatus?: string | null;
  indexedAt: string | null;
  createdAt: string;
};

export type OrgKnowledgeStats = {
  totalDocs: number;
  totalChunks: number;
  totalPersonaMoments: number;
  lastIndexedAt: string | null;
  totalSizeBytes: number;
};

export type EmbeddingPoint3D = {
  id: string;
  x: number;
  y: number;
  z: number;
  type: "knowledge" | "persona_voice";
  title: string;
  source: string;
  docId?: string;
  personaId?: string;
  chunkIndex?: number;
  action?: string;
  preview: string;
};

export type Embeddings3DResponse = {
  points: EmbeddingPoint3D[];
  stats: {
    totalPoints: number;
    knowledgePoints: number;
    personaVoicePoints: number;
  };
};

/**
 * Ensures a default primary knowledge base exists for an organization.
 */
export async function getOrCreateOrgKnowledgeBase(orgId: string): Promise<{ id: string; slug: string; name: string }> {
  let kb = await db.knowledgeBase.findFirst({
    where: { orgId },
    orderBy: { createdAt: "asc" },
  });
  if (!kb) {
    const org = await db.organization.findUnique({ where: { id: orgId }, select: { slug: true, name: true } });
    const slug = org?.slug ? `${org.slug}-knowledge` : "organization-knowledge";
    const name = org?.name ? `${org.name} Knowledge` : "Organization Knowledge";
    kb = await db.knowledgeBase.create({
      data: { orgId, slug, name },
    });
  }
  return kb;
}

/**
 * Fast Principal Component Analysis (PCA) projection from high-dimensional embeddings to 3D.
 */
export function computePCA3D(matrix: number[][], bounds = 25): [number, number, number][] {
  const n = matrix.length;
  if (n === 0) return [];
  const d = matrix[0].length;
  if (n < 3) {
    return matrix.map((_, i) => [(i * 2 - 1) * 10, 0, 0]);
  }

  // 1. Mean center
  const mean = new Float64Array(d);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < d; j++) mean[j] += matrix[i][j];
  }
  for (let j = 0; j < d; j++) mean[j] /= n;

  const centered: Float64Array[] = matrix.map((row) => {
    const c = new Float64Array(d);
    for (let j = 0; j < d; j++) c[j] = row[j] - mean[j];
    return c;
  });

  // Matrix-vector multiplication X * v (n x 1)
  const mulXv = (v: Float64Array): Float64Array => {
    const u = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      const row = centered[i];
      for (let j = 0; j < d; j++) sum += row[j] * v[j];
      u[i] = sum;
    }
    return u;
  };

  // Matrix-transpose vector multiplication X^T * u (d x 1)
  const mulXtu = (u: Float64Array): Float64Array => {
    const w = new Float64Array(d);
    for (let i = 0; i < n; i++) {
      const ui = u[i];
      if (ui === 0) continue;
      const row = centered[i];
      for (let j = 0; j < d; j++) w[j] += row[j] * ui;
    }
    return w;
  };

  const normalize = (v: Float64Array): Float64Array => {
    let sum = 0;
    for (let j = 0; j < d; j++) sum += v[j] * v[j];
    const norm = Math.sqrt(sum) || 1e-10;
    for (let j = 0; j < d; j++) v[j] /= norm;
    return v;
  };

  const dot = (a: Float64Array, b: Float64Array): number => {
    let s = 0;
    for (let j = 0; j < d; j++) s += a[j] * b[j];
    return s;
  };

  // Extract top 3 orthogonal components
  const components: Float64Array[] = [];
  for (let c = 0; c < 3; c++) {
    const v = new Float64Array(d);
    for (let j = 0; j < d; j++) v[j] = Math.sin((c + 1) * 31 + j * 17);
    normalize(v);

    for (let iter = 0; iter < 15; iter++) {
      for (const prev of components) {
        const dVal = dot(v, prev);
        for (let j = 0; j < d; j++) v[j] -= dVal * prev[j];
      }
      normalize(v);

      const u = mulXv(v);
      const w = mulXtu(u);
      normalize(w);
      for (let j = 0; j < d; j++) v[j] = w[j];
    }
    components.push(v);
  }

  // Project points
  const points: [number, number, number][] = [];
  let maxAbs = 0;
  for (let i = 0; i < n; i++) {
    const row = centered[i];
    const px = dot(row, components[0]);
    const py = dot(row, components[1]);
    const pz = dot(row, components[2]);
    maxAbs = Math.max(maxAbs, Math.abs(px), Math.abs(py), Math.abs(pz));
    points.push([px, py, pz]);
  }

  const scale = maxAbs > 0 ? bounds / maxAbs : 1;
  return points.map(([x, y, z]) => [x * scale, y * scale, z * scale]);
}

// In-memory cache for computed 3D PCA projections
const embeddingsCache = new Map<string, { data: Embeddings3DResponse; timestamp: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function invalidateOrgKnowledgeCache(orgId: string) {
  embeddingsCache.delete(orgId);
}

export class OrganizationKnowledgeService {
  /**
   * Retrieves all documents for the organization across all knowledge bases.
   */
  static async getAllDocuments(orgId: string): Promise<OrgKnowledgeDoc[]> {
    const docs = await db.knowledgeDocument.findMany({
      where: { kb: { orgId } },
      include: {
        kb: { select: { slug: true } },
        source: { select: { id: true, connector: true, status: true, sourceUrl: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return docs.map((d) => ({
      id: d.id,
      kbId: d.kbId,
      kbSlug: d.kb.slug,
      slug: d.slug,
      title: d.title || d.slug,
      ext: d.ext,
      size: d.size,
      status: d.status,
      error: d.error,
      sourceId: d.sourceId,
      externalId: d.externalId,
      sourceUrl: d.source?.sourceUrl ?? null,
      connector: d.source?.connector ?? (d.ext === "json" ? "youtube" : "upload"),
      sourceStatus: d.source?.status ?? null,
      indexedAt: d.indexedAt ? d.indexedAt.toISOString() : null,
      createdAt: d.createdAt.toISOString(),
    }));
  }

  /**
   * Retrieves organization-level knowledge and vector storage stats.
   */
  static async getStats(orgId: string): Promise<OrgKnowledgeStats> {
    const docs = await db.knowledgeDocument.findMany({
      where: { kb: { orgId } },
      select: { size: true, indexedAt: true, status: true },
    });

    const totalDocs = docs.length;
    const totalSizeBytes = docs.reduce((sum, d) => sum + d.size, 0);
    const lastIndexed = docs
      .map((d) => (d.indexedAt ? d.indexedAt.getTime() : 0))
      .reduce((max, t) => Math.max(max, t), 0);

    let totalChunks = 0;
    let totalPersonaMoments = 0;

    try {
      const collection = await MainCollectionService.getCollection(orgId);
      const totalCount = await collection.count();
      if (totalCount > 0) {
        const getCountForType = async (type: string) => {
          let count = 0;
          let offset = 0;
          const batchSize = 250;
          while (offset < totalCount) {
            const res = await collection.get({
              where: { type } as Where,
              limit: batchSize,
              offset,
            });
            count += res.ids.length;
            if (res.ids.length < batchSize) break;
            offset += batchSize;
          }
          return count;
        };

        const [kCount, pvCount] = await Promise.all([
          getCountForType("knowledge"),
          getCountForType("persona_voice"),
        ]);
        totalChunks = kCount;
        totalPersonaMoments = pvCount;
      }
    } catch (err) {
      console.warn("Failed to get Chroma stats:", err);
    }

    return {
      totalDocs,
      totalChunks,
      totalPersonaMoments,
      lastIndexedAt: lastIndexed > 0 ? new Date(lastIndexed).toISOString() : null,
      totalSizeBytes,
    };
  }

  /**
   * Uploads a document to S3 and queues background ingestion through SQS.
   * Returns immediately with 202 Accepted and queued status.
   */
  static async uploadDocument(orgId: string, file: File): Promise<OrgKnowledgeDoc & { jobId: string }> {
    const kb = await getOrCreateOrgKnowledgeBase(orgId);
    const { ext, bytes, markdown } = await documentToMarkdown(file);

    const baseSlug = file.name
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .slice(-120);
    let slug = `${baseSlug}.${ext}`;
    let n = 1;
    while (await db.knowledgeDocument.findFirst({ where: { kbId: kb.id, slug }, select: { id: true } })) {
      slug = `${baseSlug}-${n++}.${ext}`;
    }

    const doc = await db.knowledgeDocument.create({
      data: {
        kbId: kb.id,
        slug,
        title: baseSlug.replace(/[-_]/g, " "),
        ext,
        size: file.size,
        s3SourceKey: "pending",
        s3MarkdownKey: "pending",
        status: "uploaded",
      },
    });

    const sourceKey = `${kbPrefix(orgId, kb.id, doc.id)}/source-${slug}`;
    const markdownKey = `${kbPrefix(orgId, kb.id, doc.id)}/content.md`;

    await Promise.all([
      putObject(sourceKey, bytes, file.type || "application/octet-stream"),
      putObject(markdownKey, markdown, "text/markdown; charset=utf-8"),
    ]);

    await db.knowledgeDocument.update({
      where: { id: doc.id },
      data: { s3SourceKey: sourceKey, s3MarkdownKey: markdownKey },
    });

    // Ensure org tenant exists before enqueuing work
    await ChromaTenantService.createOrgDatabase(orgId);

    // Enqueue background ingestion through SQS
    const queueResult = await enqueueIngestionWork({
      orgId,
      kbId: kb.id,
      connector: "upload",
      externalId: doc.id,
      sourceUrl: `upload://${slug}`,
      rootWorkItem: {
        workKey: doc.id,
        kind: "resource",
        payload: { docId: doc.id, title: doc.title, slug: doc.slug },
      },
    });

    await db.knowledgeDocument.update({
      where: { id: doc.id },
      data: { sourceId: queueResult.sourceId, status: "queued" },
    });

    invalidateOrgKnowledgeCache(orgId);

    return {
      id: doc.id,
      kbId: kb.id,
      kbSlug: kb.slug,
      slug: doc.slug,
      title: doc.title,
      ext: doc.ext,
      size: doc.size,
      status: "queued",
      error: null,
      chunkCount: 0,
      sourceId: queueResult.sourceId,
      connector: "upload",
      sourceStatus: "syncing",
      jobId: queueResult.jobId,
      indexedAt: null,
      createdAt: doc.createdAt.toISOString(),
    };
  }

  /**
   * Deletes a document from Postgres, S3, and ChromaDB, canceling any pending jobs.
   */
  static async deleteDocument(orgId: string, docId: string): Promise<void> {
    const doc = await db.knowledgeDocument.findFirst({
      where: { id: docId, kb: { orgId } },
      include: { kb: { select: { id: true } } },
    });
    if (!doc) throw new Error("Document not found");

    if (doc.sourceId) {
      await db.ingestionWorkItem.updateMany({
        where: {
          job: { sourceId: doc.sourceId },
          status: { in: ["queued", "running"] },
        },
        data: { status: "failed", error: "Document deleted" },
      });
      await db.ingestionJob.updateMany({
        where: {
          sourceId: doc.sourceId,
          status: { in: ["queued", "running"] },
        },
        data: { status: "failed", error: "Document deleted", activeKey: null },
      });
    }

    await Promise.all([
      MainCollectionService.removeKnowledgeDoc(orgId, doc.id),
      deletePrefix(kbPrefix(orgId, doc.kbId, doc.id)),
    ]);

    await db.knowledgeDocument.delete({ where: { id: doc.id } });
    invalidateOrgKnowledgeCache(orgId);
  }

  /**
   * Re-indexes an existing document asynchronously by dispatching an SQS job.
   */
  static async reindexDocument(orgId: string, docId: string): Promise<{
    ok: true;
    jobId: string;
    documentId: string;
    status: "queued";
  }> {
    const doc = await db.knowledgeDocument.findFirst({
      where: { id: docId, kb: { orgId } },
      include: { kb: { select: { id: true, slug: true } } },
    });
    if (!doc) throw new Error("Document not found");
    if (!doc.s3MarkdownKey || doc.s3MarkdownKey === "pending") {
      throw new Error("Document has no markdown stored in S3");
    }

    await ChromaTenantService.createOrgDatabase(orgId);

    const queueResult = await enqueueIngestionWork({
      orgId,
      kbId: doc.kbId,
      connector: "upload",
      externalId: doc.id,
      sourceUrl: `upload://${doc.slug}`,
      rootWorkItem: {
        workKey: doc.id,
        kind: "resource",
        payload: { docId: doc.id, title: doc.title, slug: doc.slug },
      },
    });

    await db.knowledgeDocument.update({
      where: { id: doc.id },
      data: {
        sourceId: queueResult.sourceId,
        status: "queued",
        error: null,
      },
    });
    invalidateOrgKnowledgeCache(orgId);

    return {
      ok: true,
      jobId: queueResult.jobId,
      documentId: doc.id,
      status: "queued",
    };
  }

  /**
   * Returns a presigned preview URL for viewing the original file in the browser.
   */
  static async getPreviewUrl(orgId: string, docId: string): Promise<string | null> {
    const doc = await db.knowledgeDocument.findFirst({
      where: { id: docId, kb: { orgId } },
      select: { s3SourceKey: true },
    });
    if (!doc || !doc.s3SourceKey || doc.s3SourceKey === "pending") return null;
    return presignedGetUrl(doc.s3SourceKey);
  }

  /**
   * Retrieves the raw chunks of a document from Chroma for the inspection drawer.
   */
  static async getDocumentChunks(
    orgId: string,
    docId: string,
  ): Promise<{ id: string; chunkIndex: number; text: string }[]> {
    const collection = await MainCollectionService.getCollection(orgId);
    const res = await collection.get({
      where: {
        $and: [{ type: "knowledge" }, { docId }],
      } as Where,
      limit: 300,
      include: ["documents", "metadatas"],
    });

    const items: { id: string; chunkIndex: number; text: string }[] = [];
    const ids = res.ids ?? [];
    const docs = res.documents ?? [];
    const metas = (res.metadatas ?? []) as Record<string, unknown>[];

    for (let i = 0; i < ids.length; i++) {
      const meta = metas[i] ?? {};
      items.push({
        id: ids[i],
        chunkIndex: Number(meta.chunkIndex ?? i),
        text: docs[i] ?? "",
      });
    }

    return items.sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  /**
   * Fetches vectors from Chroma in batches (<= 250 to respect Chroma Cloud quotas),
   * computes 3D coordinates via PCA, and returns points.
   */
  static async get3DPoints(orgId: string, limit = 2000, forceRefresh = false): Promise<Embeddings3DResponse> {
    if (!forceRefresh) {
      const cached = embeddingsCache.get(orgId);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.data;
      }
    }

    const collection = await MainCollectionService.getCollection(orgId);
    const totalCount = await collection.count();
    if (totalCount === 0) {
      return {
        points: [],
        stats: { totalPoints: 0, knowledgePoints: 0, personaVoicePoints: 0 },
      };
    }

    const targetLimit = Math.min(limit, totalCount);
    const BATCH_SIZE = 250;

    const allIds: string[] = [];
    const allEmbeddings: number[][] = [];
    const allDocs: (string | null)[] = [];
    const allMetas: (Record<string, unknown> | null)[] = [];

    for (let offset = 0; offset < targetLimit; offset += BATCH_SIZE) {
      const fetchLimit = Math.min(BATCH_SIZE, targetLimit - offset);
      const res = await collection.get({
        limit: fetchLimit,
        offset,
        include: ["embeddings", "documents", "metadatas"],
      });

      if (!res.ids || res.ids.length === 0) break;
      allIds.push(...res.ids);
      if (res.embeddings) allEmbeddings.push(...(res.embeddings as number[][]));
      if (res.documents) allDocs.push(...res.documents);
      if (res.metadatas) allMetas.push(...(res.metadatas as Record<string, unknown>[]));

      if (res.ids.length < fetchLimit) break;
    }

    if (allIds.length === 0 || allEmbeddings.length === 0) {
      return {
        points: [],
        stats: { totalPoints: 0, knowledgePoints: 0, personaVoicePoints: 0 },
      };
    }

    const projected = computePCA3D(allEmbeddings, 30);
    let knowledgePoints = 0;
    let personaVoicePoints = 0;

    const points: EmbeddingPoint3D[] = [];
    for (let i = 0; i < allIds.length; i++) {
      const meta = allMetas[i] ?? {};
      const [x, y, z] = projected[i] ?? [0, 0, 0];
      const type = (meta.type === "persona_voice" ? "persona_voice" : "knowledge") as "knowledge" | "persona_voice";
      if (type === "knowledge") knowledgePoints++;
      else personaVoicePoints++;

      const rawDoc = allDocs[i] ?? "";
      const preview = rawDoc.length > 200 ? `${rawDoc.slice(0, 200)}...` : rawDoc;

      points.push({
        id: allIds[i],
        x: Number(x.toFixed(3)),
        y: Number(y.toFixed(3)),
        z: Number(z.toFixed(3)),
        type,
        title: String(meta.title ?? meta.sourceName ?? meta.source ?? "Untitled"),
        source: String(meta.source ?? meta.sourceName ?? ""),
        docId: meta.docId ? String(meta.docId) : undefined,
        personaId: meta.personaId ? String(meta.personaId) : undefined,
        chunkIndex: meta.chunkIndex !== undefined ? Number(meta.chunkIndex) : undefined,
        action: meta.action ? String(meta.action) : undefined,
        preview,
      });
    }

    const result: Embeddings3DResponse = {
      points,
      stats: {
        totalPoints: points.length,
        knowledgePoints,
        personaVoicePoints,
      },
    };
    embeddingsCache.set(orgId, { data: result, timestamp: Date.now() });
    return result;
  }
}

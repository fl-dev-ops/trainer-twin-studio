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
}

import type { Where } from "chromadb";
import { db } from "@/lib/db";
import { MainCollectionService } from "@/lib/main-collection";
import { deletePrefix, kbPrefix, orgPrefix, presignedGetUrl, putObject } from "@/lib/s3";
import { KNOWLEDGE_UPLOAD_EXTENSIONS } from "@/lib/documents";
import { queueKnowledgeFile } from "@/lib/ingestion-queue";

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
      sourceUrl: d.source?.sourceUrl ?? (d.externalId?.startsWith("google-drive:")
        ? `https://drive.google.com/file/d/${encodeURIComponent(d.externalId.slice("google-drive:".length))}/view` : null),
      connector: d.source?.connector ?? (
        d.s3SourceKey.startsWith(`${orgPrefix(orgId)}/knowledge/files/`) ? "upload" : d.ext === "json" ? "youtube" : "upload"
      ),
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
   * Stores the original file and queues it for the ingestion worker, which converts it to redacted
   * Markdown, chunks and embeds it, and reports back to /api/internal/ingestion/results.
   */
  static async uploadDocument(orgId: string, file: File, maxBytes = 25 * 1024 * 1024): Promise<OrgKnowledgeDoc & { jobId: string | null }> {
    const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    if (!(KNOWLEDGE_UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new Error(`Unsupported file type .${ext} — supported: ${KNOWLEDGE_UPLOAD_EXTENSIONS.join(", ")}`);
    }
    if (file.size > maxBytes) throw new Error(`File larger than ${Math.floor(maxBytes / 1024 / 1024)} MB`);
    if (file.size === 0) throw new Error("File is empty");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kb = await getOrCreateOrgKnowledgeBase(orgId);

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
        status: "uploading",
      },
    });

    // Per-document folders prevent filename collisions and let deletion remove every copy safely.
    const sourceKey = `${orgPrefix(orgId)}/knowledge/files/${doc.id}/${slug}`;
    try {
      await putObject(sourceKey, bytes, file.type || "application/octet-stream");
    } catch (error) {
      // Keep the key for cleanup; never report a partial upload as complete.
      await db.knowledgeDocument.update({
        where: { id: doc.id },
        data: { s3SourceKey: sourceKey, status: "failed", error: error instanceof Error ? error.message : "Upload failed" },
      });
      throw error;
    }

    let status = "uploaded";
    let error: string | null = null;
    try {
      if (await queueKnowledgeFile({ docId: doc.id, orgId, kbId: kb.id, filename: slug, sourceKey })) status = "queued";
    } catch (queueError) {
      // The file is stored; reindexDocument can queue it again.
      console.error(`[OrgKnowledge] could not queue document ${doc.id}:`, queueError);
      error = "Stored, but processing could not be queued. Retry from the document menu.";
    }
    await db.knowledgeDocument.update({ where: { id: doc.id }, data: { s3SourceKey: sourceKey, status, error } });

    return {
      id: doc.id,
      kbId: kb.id,
      kbSlug: kb.slug,
      slug: doc.slug,
      title: doc.title,
      ext: doc.ext,
      size: doc.size,
      status,
      error,
      chunkCount: 0,
      sourceId: null,
      connector: "upload",
      sourceStatus: null,
      jobId: null,
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

    const storedOnly = doc.s3SourceKey.startsWith(`${orgPrefix(orgId)}/knowledge/files/`) && !doc.sourceId && !doc.indexedAt;
    await Promise.all([
      storedOnly ? Promise.resolve() : MainCollectionService.removeKnowledgeDoc(orgId, doc.id),
      deletePrefix(`${kbPrefix(orgId, doc.kbId, doc.id)}/`), // Existing documents keep their original keys.
      deletePrefix(`${orgPrefix(orgId)}/knowledge/files/${doc.id}/`),
      deletePrefix(`${orgPrefix(orgId)}/ingest/files/${doc.id}/`),
    ]);

    await db.knowledgeDocument.delete({ where: { id: doc.id } });
  }

  /** Queues an uploaded document for the ingestion worker again (re-redact, re-chunk, re-embed). */
  static async reindexDocument(orgId: string, docId: string): Promise<{
    ok: true;
    jobId: string;
    documentId: string;
    status: "queued";
  }> {
    const doc = await db.knowledgeDocument.findFirst({ where: { id: docId, kb: { orgId } } });
    if (!doc) throw new Error("Document not found");
    if (!doc.s3SourceKey || doc.s3SourceKey === "pending") throw new Error("Document has no stored file");
    if (!(await queueKnowledgeFile({ docId: doc.id, orgId, kbId: doc.kbId, filename: doc.slug, sourceKey: doc.s3SourceKey }))) {
      throw new Error("Ingestion queue is not configured");
    }
    await db.knowledgeDocument.update({ where: { id: doc.id }, data: { status: "queued", error: null } });
    return { ok: true, jobId: doc.id, documentId: doc.id, status: "queued" };
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

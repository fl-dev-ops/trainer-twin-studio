import { NextResponse } from "next/server";
import { z } from "zod";
import { ChromaTenantService } from "@/lib/chroma-tenant";
import { db } from "@/lib/db";
import { queueKnowledgeFile } from "@/lib/ingestion-queue";
import { MainCollectionService } from "@/lib/main-collection";
import { deletePrefix, orgPrefix, putObject } from "@/lib/s3";

/**
 * Results from the Python ingestion worker (ingestion/src/ingestion/worker.py) for one knowledge item:
 * fetched (a video page was downloaded into S3: queue processing), then
 * start -> chunks (batches) -> complete, or failed. Each step is idempotent; a worker retry repeats them.
 * The worker holds no S3/Chroma credentials: this route stores the redacted Markdown and chunk files
 * in S3 and writes the worker's chunk embeddings to the org's Chroma database (no re-embedding).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const ids = { docId: z.string().min(1).max(128), orgId: z.string().min(1), kbId: z.string().min(1) };
const chunk = z.object({
  index: z.number().int().min(0),
  text: z.string().min(1).max(200_000),
  startIndex: z.number().int().min(0),
  endIndex: z.number().int().min(0),
  tokenCount: z.number().int().min(0),
  embedding: z.array(z.number()).min(1).max(4096),
});
const resultSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fetched"), ...ids, size: z.number().int().min(1), durationSeconds: z.number().nullable() }),
  z.object({ type: z.literal("start"), ...ids }),
  z.object({ type: z.literal("chunks"), ...ids, batch: z.number().int().min(0), chunkingVersion: z.string(), chunks: z.array(chunk).min(1).max(100) }),
  z.object({ type: z.literal("complete"), ...ids, markdown: z.string().min(1).max(4_000_000), chunkCount: z.number().int().min(0), chunkingVersion: z.string() }),
  z.object({ type: z.literal("failed"), ...ids, error: z.string().max(1000), final: z.boolean() }),
]);

function isAuthorized(request: Request): boolean {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) return !process.env.VERCEL; // fail open only off-Vercel (local dev)
  return request.headers.get("x-internal-secret") === secret;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = resultSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid result", issues: parsed.error.issues.slice(0, 5) }, { status: 400 });
  const result = parsed.data;

  // The ids come from our own queue, but a document must still belong to the org and KB it claims.
  const doc = await db.knowledgeDocument.findFirst({
    where: { id: result.docId, kbId: result.kbId, kb: { orgId: result.orgId } },
    select: { id: true, slug: true, title: true, s3SourceKey: true },
  });
  if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 }); // deleted: worker drops the message

  const base = `${orgPrefix(result.orgId)}/ingest/files/${doc.id}`;
  try {
    switch (result.type) {
      case "fetched": {
        // The raw video is in our S3 now; processing reads it from there.
        await db.knowledgeDocument.update({ where: { id: doc.id }, data: { size: result.size, status: "queued", error: null } });
        const queued = await queueKnowledgeFile({
          docId: doc.id, orgId: result.orgId, kbId: result.kbId, filename: doc.slug, sourceKey: doc.s3SourceKey,
        });
        if (!queued) throw new Error("Ingestion queue is not configured");
        break;
      }
      case "start":
        await ChromaTenantService.createOrgDatabase(result.orgId);
        await deletePrefix(`${base}/chunks/`); // chunk files from an earlier run
        await db.knowledgeDocument.update({ where: { id: doc.id }, data: { status: "digesting", error: null } });
        break;
      case "chunks":
        await MainCollectionService.upsertKnowledgeChunks(
          result.orgId,
          { kbId: result.kbId, docId: doc.id, source: doc.slug, title: doc.title, chunkingVersion: result.chunkingVersion },
          result.chunks,
        );
        await putObject(`${base}/chunks/part-${String(result.batch).padStart(4, "0")}.jsonl`,
          result.chunks.map((c) => JSON.stringify(c)).join("\n") + "\n", "application/x-ndjson");
        break;
      case "complete": {
        const markdownKey = `${base}/content.md`;
        await putObject(markdownKey, result.markdown, "text/markdown; charset=utf-8");
        await MainCollectionService.pruneKnowledgeChunks(result.orgId, doc.id, result.chunkCount);
        await db.knowledgeDocument.update({
          where: { id: doc.id },
          data: { status: "indexed", indexedAt: new Date(), s3MarkdownKey: markdownKey, error: null },
        });
        break;
      }
      case "failed":
        await db.knowledgeDocument.update({
          where: { id: doc.id },
          data: { error: result.error, ...(result.final ? { status: "failed" } : {}) },
        });
        break;
    }
  } catch (error) {
    console.error(`[API:internal:ingestion:results] ${result.type} failed for ${doc.id}:`, error);
    return NextResponse.json({ error: "Could not store the result" }, { status: 500 }); // worker retries
  }
  return NextResponse.json({ ok: true });
}

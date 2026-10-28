import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Pool } from "pg";
import { ChunkingService } from "../../chunking";
import type { PipelineConfig } from "../../config";
import { classifySections, indexDocument } from "../../knowledge";
import type { IngestionAdapter, JobContext, WorkItemContext } from "../types";

export const uploadAdapter: IngestionAdapter = {
  async process(pool: Pool, config: PipelineConfig, job: JobContext, workItem: WorkItemContext): Promise<void> {
    const docId = workItem.workKey;
    const docResult = await pool.query<{
      id: string;
      title: string;
      slug: string;
      ext: string;
      s3MarkdownKey: string | null;
      s3SourceKey: string;
    }>(
      `SELECT id, title, slug, ext, "s3MarkdownKey", "s3SourceKey" FROM "KnowledgeDocument" WHERE id = $1 AND "kbId" = $2`,
      [docId, job.kbId],
    );

    if (docResult.rowCount === 0) {
      throw new Error(`KnowledgeDocument ${docId} not found in knowledge base ${job.kbId}`);
    }

    const document = docResult.rows[0];
    let markdownKey: string | null = document.s3MarkdownKey;

    if (!markdownKey) {
      const normalizedExt = document.ext ? document.ext.toLowerCase().replace(/^\./, "") : "";
      const TEXT_EXTENSIONS = new Set(["md", "txt", "markdown"]);
      if (TEXT_EXTENSIONS.has(normalizedExt)) {
        markdownKey = document.s3SourceKey;
      } else {
        throw new Error(
          `KnowledgeDocument ${docId} has no markdown representation (s3MarkdownKey is null) and binary extension "${document.ext}" cannot be processed as raw text`,
        );
      }
    }

    // Read markdown from S3
    const s3 = new S3Client({ region: config.awsRegion });
    const s3Response = await s3.send(
      new GetObjectCommand({
        Bucket: config.s3Bucket,
        Key: markdownKey,
      }),
    );

    const markdown = (await s3Response.Body?.transformToString("utf-8")) ?? "";
    if (!markdown.trim()) {
      await pool.query(
        `UPDATE "KnowledgeDocument" SET status = 'failed', error = 'Document content is empty', "updatedAt" = NOW() WHERE id = $1`,
        [document.id],
      );
      return;
    }

    await pool.query(
      `UPDATE "KnowledgeDocument" SET status = 'digesting', error = NULL, "updatedAt" = NOW() WHERE id = $1`,
      [document.id],
    );

    // Chunk and classify
    const prepared = await new ChunkingService().prepare("markdown", {
      text: markdown,
      pageTitle: document.title,
    });
    const chunks = await classifySections(pool, config, prepared.sourceText, prepared);

    // Index into Chroma main collection
    const chunkCount = await indexDocument(
      config,
      job,
      document.id,
      document.slug,
      chunks,
      {
        pageTitle: document.title,
        chunkingVersion: prepared.chunkingVersion,
      },
    );

    await pool.query(
      `UPDATE "KnowledgeDocument" SET status = 'indexed', "indexedAt" = NOW(), error = NULL, "updatedAt" = NOW() WHERE id = $1`,
      [document.id],
    );

    await pool.query(
      `UPDATE "IngestionWorkItem" SET "chunkCount" = $1 WHERE id = $2`,
      [chunkCount, workItem.id],
    );
  },
};

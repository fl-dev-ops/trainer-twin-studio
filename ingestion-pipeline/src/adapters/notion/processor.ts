import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { Pool } from "pg";
import { ChunkingService } from "../../chunking";
import type { PipelineConfig } from "../../config";
import { classifySections, indexDocument, removeDocument } from "../../knowledge";
import { identifierOnlyMessage } from "../../message";
import type { IngestionAdapter, JobContext, WorkItemContext } from "../types";
import { decryptNotionToken, getNotionMarkdown, getNotionPage, listNotionChildPageIds, type NotionPage } from "./acquisition";
import { NotionCleaner } from "./cleaner";
import { getPublicNotionPage } from "./public-acquisition";

type StoredDocument = { id: string; slug: string };

function documentSlug(title: string, externalId: string) {
  const base = title.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[^a-zA-Z0-9]+/, "").replace(/[-.]+$/, "").slice(0, 60) || "page";
  return `notion_${base}-${externalId.replaceAll("-", "").slice(0, 12)}.md`;
}

async function enqueueChild(pool: Pool, config: PipelineConfig, job: JobContext, parent: WorkItemContext, externalId: string) {
  const result = await pool.query<{ id: string; inserted: boolean }>(`INSERT INTO "IngestionWorkItem"
    (id,"jobId","workKey","parentWorkItemId",kind,status,"createdAt","updatedAt")
    VALUES ($1,$2,$3,$4,'resource','queued',NOW(),NOW())
    ON CONFLICT ("jobId","workKey") DO UPDATE SET "parentWorkItemId" = EXCLUDED."parentWorkItemId", "updatedAt" = NOW()
      WHERE "IngestionWorkItem"."enqueuedAt" IS NULL AND "IngestionWorkItem".status = 'queued'
    RETURNING id, (xmax = 0) AS inserted`, [crypto.randomUUID(), job.jobId, externalId, parent.id]);
  if (result.rowCount !== 1) return;
  if (result.rows[0].inserted) {
    await pool.query(`UPDATE "IngestionJob" SET "itemsDiscovered" = "itemsDiscovered" + 1, "updatedAt" = NOW() WHERE id = $1`, [job.jobId]);
  }
  await new SQSClient({ region: config.awsRegion }).send(new SendMessageCommand({
    QueueUrl: config.queueUrl,
    MessageBody: identifierOnlyMessage({ jobId: job.jobId, workItemId: result.rows[0].id }),
  }));
  await pool.query(`UPDATE "IngestionWorkItem" SET "enqueuedAt" = NOW(), "updatedAt" = NOW()
    WHERE id = $1 AND "enqueuedAt" IS NULL`, [result.rows[0].id]);
}

async function upsertDocument(pool: Pool, job: JobContext, workItem: WorkItemContext, title: string, markdown: string, updatedAt: Date): Promise<StoredDocument> {
  const size = new TextEncoder().encode(markdown).byteLength;
  const slug = `${job.sourceConnector === "notion_public" ? `public_${job.sourceId}_` : ""}${documentSlug(title, workItem.workKey)}`;
  const result = await pool.query<StoredDocument>(`INSERT INTO "KnowledgeDocument"
    (id,"kbId","sourceId","externalId","externalUpdatedAt","parentExternalId",slug,title,ext,size,"s3SourceKey","s3MarkdownKey",status,"createdAt","updatedAt")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'md',$9,'pending','pending','uploaded',NOW(),NOW())
    ON CONFLICT ("sourceId","externalId") DO UPDATE SET "externalUpdatedAt" = EXCLUDED."externalUpdatedAt",
      "parentExternalId" = EXCLUDED."parentExternalId", title = EXCLUDED.title, size = EXCLUDED.size,
      status = 'uploaded', error = NULL, "updatedAt" = NOW() RETURNING id, slug`,
    [crypto.randomUUID(), job.kbId, job.sourceId, workItem.workKey, updatedAt, workItem.parentWorkKey, slug, title, size]);
  return result.rows[0];
}

async function writeMarkdown(pool: Pool, config: PipelineConfig, job: JobContext, document: StoredDocument, markdown: string) {
  const key = `${config.s3BasePrefix}/${job.orgId}/${job.kbSlug}/${document.id}/content.md`;
  await new S3Client({ region: config.awsRegion }).send(new PutObjectCommand({
    Bucket: config.s3Bucket,
    Key: key,
    Body: markdown,
    ContentType: "text/markdown; charset=utf-8",
  }));
  await pool.query(`UPDATE "KnowledgeDocument" SET "s3SourceKey" = $1, "s3MarkdownKey" = $1, "updatedAt" = NOW() WHERE id = $2`, [key, document.id]);
}

async function removeEmptyDocument(pool: Pool, config: PipelineConfig, job: JobContext, externalId: string) {
  const result = await pool.query<{ id: string }>(`SELECT id FROM "KnowledgeDocument" WHERE "sourceId" = $1 AND "externalId" = $2`, [job.sourceId, externalId]);
  for (const document of result.rows) await removeDocument(config, job.kbSlug, document.id);
  await pool.query(`DELETE FROM "KnowledgeDocument" WHERE "sourceId" = $1 AND "externalId" = $2`, [job.sourceId, externalId]);
}

export const notionAdapter: IngestionAdapter = {
  async process(pool, config, job, workItem) {
    if (workItem.kind !== "resource") throw new Error(`Unsupported Notion work item kind: ${workItem.kind}`);
    let page: NotionPage;
    let children: string[];
    let rawMarkdown: string;
    if (job.sourceConnector === "notion_public") {
      const result = await getPublicNotionPage(workItem.workKey);
      page = result.page;
      children = result.children;
      rawMarkdown = result.markdown;
    } else {
      if (!job.accessTokenCiphertext) throw new Error("Notion connection has no access token");
      const token = decryptNotionToken(job.accessTokenCiphertext, config.notionTokenEncryptionKey);
      page = await getNotionPage(config, workItem.workKey, token);
      children = await listNotionChildPageIds(config, page.id, token);
      rawMarkdown = await getNotionMarkdown(config, page.id, token);
    }
    for (const childId of children) await enqueueChild(pool, config, job, workItem, childId);
    const content = new NotionCleaner().clean(rawMarkdown);
    if (!content) {
      await removeEmptyDocument(pool, config, job, workItem.workKey);
      return;
    }
    const markdown = `# ${page.title}\n\n${content}`;
    const document = await upsertDocument(pool, job, workItem, page.title, markdown, page.lastEditedAt);
    await writeMarkdown(pool, config, job, document, markdown);
    await pool.query(`UPDATE "KnowledgeDocument" SET status = 'digesting', error = NULL, "updatedAt" = NOW() WHERE id = $1`, [document.id]);
    const prepared = await new ChunkingService().prepare("notion", { text: markdown, pageTitle: page.title });
    const chunks = await classifySections(pool, config, prepared.sourceText, prepared);
    const chunkCount = await indexDocument(config, job.kbSlug, document.id, document.slug, chunks,
      { pageId: page.id, pageTitle: prepared.pageTitle, chunkingVersion: prepared.chunkingVersion });
    await pool.query(`UPDATE "KnowledgeDocument" SET status = $2, error = $3, "indexedAt" = $4, "updatedAt" = NOW() WHERE id = $1`,
      [document.id, chunkCount ? "indexed" : "failed", chunkCount ? null : "No content indexed", chunkCount ? new Date() : null]);
  },
};

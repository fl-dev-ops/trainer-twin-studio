import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { Pool } from "pg";
import { classifySections, indexDocument, removeDocument } from "./knowledge";
import { ChunkingService } from "./chunking";
import { createSourceCleaner } from "./cleaners/factory";
import { loadConfig, type PipelineConfig } from "./config";
import { decryptNotionToken, getNotionMarkdown, getNotionPage, listNotionChildPageIds, type NotionPage } from "./notion";
import { getPublicNotionPage } from "./notion-public";
import { processYouTubeImport } from "./youtube";
import { YouTubeError } from "../../shared/youtube/types";
import { maintainYouTubeImports } from "./youtube-maintenance";
import { identifierOnlyMessage, parseQueueMessage, type IngestionMessage } from "./message";

type SqsRecord = { messageId: string; body: string; attributes?: { ApproximateReceiveCount?: string } };
type SqsEvent = { Records: SqsRecord[] };
type SqsResult = { batchItemFailures: { itemIdentifier: string }[] };

type JobContext = {
  jobId: string;
  sourceId: string;
  orgId: string;
  kbId: string;
  kbSlug: string;
  status: string;
  sourceConnector: "notion" | "notion_public" | "youtube";
  accessTokenCiphertext: string | null;
  youtubeConnectionId: string | null;
  connectionUserId: string | null;
  externalId: string;
};
type WorkItemContext = {
  id: string;
  workKey: string;
  parentWorkItemId: string | null;
  parentWorkKey: string | null;
  kind: string;
  payload: unknown;
};
type StoredDocument = { id: string; slug: string };

let pool: Pool | undefined;

function database(config: PipelineConfig) {
  pool ??= new Pool({ connectionString: config.databaseUrl, max: 4 });
  return pool;
}

function documentSlug(connector: string, title: string, externalId: string) {
  const prefix = connector === "youtube" ? "youtube_" : "notion_";
  const base = title.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[^a-zA-Z0-9]+/, "").replace(/[-.]+$/, "").slice(0, 60) || "page";
  return `${prefix}${base}-${externalId.replaceAll("-", "").slice(0, 12)}.md`;
}

async function loadContext(context: Pool, message: IngestionMessage): Promise<{ job: JobContext; workItem: WorkItemContext }> {
  const result = await context.query<JobContext & WorkItemContext>(`
    SELECT job.id AS "jobId", source.id AS "sourceId", source."orgId", source."kbId", kb.slug AS "kbSlug",
      job.status, source.connector AS "sourceConnector", notion_connection."accessTokenCiphertext",
      youtube_config."connectionId" AS "youtubeConnectionId", youtube_connection."userId" AS "connectionUserId",
      source."externalId", item.id, item."workKey", item."parentWorkItemId", parent."workKey" AS "parentWorkKey",
      item.kind, item.payload
    FROM "IngestionWorkItem" item
    JOIN "IngestionJob" job ON job.id = item."jobId"
    JOIN "KnowledgeSource" source ON source.id = job."sourceId"
    JOIN "KnowledgeBase" kb ON kb.id = source."kbId" AND kb."orgId" = source."orgId"
    LEFT JOIN "IngestionWorkItem" parent ON parent.id = item."parentWorkItemId"
    LEFT JOIN "NotionSourceConfig" notion_config ON notion_config."sourceId" = source.id
    LEFT JOIN "NotionConnection" notion_connection ON notion_connection.id = notion_config."connectionId" AND notion_connection."orgId" = source."orgId"
    LEFT JOIN "YouTubeSourceConfig" youtube_config ON youtube_config."sourceId" = source.id
    LEFT JOIN "YouTubeConnection" youtube_connection ON youtube_connection.id = youtube_config."connectionId" AND youtube_connection."orgId" = source."orgId"
    WHERE job.id = $1 AND item.id = $2 AND source.connector IN ('notion', 'notion_public', 'youtube')
  `, [message.jobId, message.workItemId]);
  if (result.rowCount !== 1) throw new Error("Ingestion job/work item was not found");
  const row = result.rows[0];
  return {
    job: {
      jobId: row.jobId, sourceId: row.sourceId, orgId: row.orgId, kbId: row.kbId, kbSlug: row.kbSlug,
      status: row.status, sourceConnector: row.sourceConnector, accessTokenCiphertext: row.accessTokenCiphertext,
      youtubeConnectionId: row.youtubeConnectionId, connectionUserId: row.connectionUserId, externalId: row.externalId,
    },
    workItem: {
      id: row.id, workKey: row.workKey, parentWorkItemId: row.parentWorkItemId,
      parentWorkKey: row.parentWorkKey, kind: row.kind, payload: row.payload,
    },
  };
}

/** Claims queued work or an invocation whose explicit lease expired. */
async function claimWorkItem(context: Pool, jobId: string, workItemId: string): Promise<boolean> {
  const result = await context.query(`UPDATE "IngestionWorkItem"
    SET status = 'running', error = NULL, "attemptCount" = "attemptCount" + 1,
      "leaseExpiresAt" = NOW() + INTERVAL '11 minutes', "updatedAt" = NOW()
    WHERE id = $1 AND "jobId" = $2
      AND (status = 'queued' OR (status = 'running' AND "leaseExpiresAt" < NOW())) RETURNING id`, [workItemId, jobId]);
  return result.rowCount === 1;
}

async function startJob(context: Pool, job: JobContext) {
  await context.query(`UPDATE "IngestionJob" SET status = 'running', "startedAt" = COALESCE("startedAt", NOW()), error = NULL, "updatedAt" = NOW()
    WHERE id = $1 AND status IN ('queued','running')`, [job.jobId]);
  await context.query(`UPDATE "KnowledgeSource" SET status = 'syncing', error = NULL, "updatedAt" = NOW() WHERE id = $1
    AND ($2 <> 'youtube' OR (status <> 'expiring' AND EXISTS (SELECT 1 FROM "IngestionJob" WHERE id = $3 AND status = 'running')))`,
    [job.sourceId, job.sourceConnector, job.jobId]);
}

async function sendWorkItem(sqs: SQSClient, config: PipelineConfig, jobId: string, workItemId: string) {
  await sqs.send(new SendMessageCommand({ QueueUrl: config.queueUrl, MessageBody: identifierOnlyMessage({ jobId, workItemId }) }));
}

/** Sends committed queued rows whose previous SQS publication did not finish. */
async function enqueueQueuedWorkItems(context: Pool, config: PipelineConfig, jobId: string) {
  const pending = await context.query<{ id: string }>(`SELECT id FROM "IngestionWorkItem"
    WHERE "jobId" = $1 AND status = 'queued' AND "enqueuedAt" IS NULL ORDER BY "createdAt" LIMIT 100`, [jobId]);
  const sqs = new SQSClient({ region: config.awsRegion });
  for (const item of pending.rows) {
    await sendWorkItem(sqs, config, jobId, item.id);
    await context.query(`UPDATE "IngestionWorkItem" SET "enqueuedAt" = NOW(), "updatedAt" = NOW()
      WHERE id = $1 AND "enqueuedAt" IS NULL`, [item.id]);
  }
}

async function enqueueNotionChild(context: Pool, config: PipelineConfig, job: JobContext, parent: WorkItemContext, externalId: string) {
  const result = await context.query<{ id: string; inserted: boolean }>(`INSERT INTO "IngestionWorkItem"
    (id,"jobId","workKey","parentWorkItemId",kind,status,"createdAt","updatedAt")
    VALUES ($1,$2,$3,$4,'resource','queued',NOW(),NOW())
    ON CONFLICT ("jobId","workKey") DO UPDATE SET "parentWorkItemId" = EXCLUDED."parentWorkItemId", "updatedAt" = NOW()
      WHERE "IngestionWorkItem"."enqueuedAt" IS NULL AND "IngestionWorkItem".status = 'queued'
    RETURNING id, (xmax = 0) AS inserted`, [crypto.randomUUID(), job.jobId, externalId, parent.id]);
  if (result.rowCount !== 1) return;
  if (result.rows[0].inserted) {
    await context.query(`UPDATE "IngestionJob" SET "itemsDiscovered" = "itemsDiscovered" + 1, "updatedAt" = NOW() WHERE id = $1`, [job.jobId]);
  }
  await sendWorkItem(new SQSClient({ region: config.awsRegion }), config, job.jobId, result.rows[0].id);
  await context.query(`UPDATE "IngestionWorkItem" SET "enqueuedAt" = NOW(), "updatedAt" = NOW()
    WHERE id = $1 AND "enqueuedAt" IS NULL`, [result.rows[0].id]);
}

async function upsertDocument(context: Pool, job: JobContext, workItem: WorkItemContext, title: string, markdown: string, updatedAt: Date): Promise<StoredDocument> {
  const size = new TextEncoder().encode(markdown).byteLength;
  const slug = `${job.sourceConnector === "notion_public" ? `public_${job.sourceId}_` : ""}${documentSlug(job.sourceConnector, title, workItem.workKey)}`;
  const result = await context.query<StoredDocument>(`INSERT INTO "KnowledgeDocument"
    (id,"kbId","sourceId","externalId","externalUpdatedAt","parentExternalId",slug,title,ext,size,"s3SourceKey","s3MarkdownKey",status,"createdAt","updatedAt")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'md',$9,'pending','pending','uploaded',NOW(),NOW())
    ON CONFLICT ("sourceId","externalId") DO UPDATE SET "externalUpdatedAt" = EXCLUDED."externalUpdatedAt",
      "parentExternalId" = EXCLUDED."parentExternalId", title = EXCLUDED.title, size = EXCLUDED.size,
      status = 'uploaded', error = NULL, "updatedAt" = NOW() RETURNING id, slug`,
    [crypto.randomUUID(), job.kbId, job.sourceId, workItem.workKey, updatedAt, workItem.parentWorkKey, slug, title, size]);
  return result.rows[0];
}

async function writeMarkdown(context: Pool, config: PipelineConfig, job: JobContext, document: StoredDocument, markdown: string) {
  const key = `${config.s3BasePrefix}/${job.orgId}/${job.kbSlug}/${document.id}/content.md`;
  await new S3Client({ region: config.awsRegion }).send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: key, Body: markdown, ContentType: "text/markdown; charset=utf-8" }));
  await context.query(`UPDATE "KnowledgeDocument" SET "s3SourceKey" = $1, "s3MarkdownKey" = $1, "updatedAt" = NOW() WHERE id = $2`, [key, document.id]);
}

async function removeEmptyDocument(context: Pool, config: PipelineConfig, job: JobContext, externalId: string) {
  const result = await context.query<{ id: string }>(`SELECT id FROM "KnowledgeDocument" WHERE "sourceId" = $1 AND "externalId" = $2`, [job.sourceId, externalId]);
  for (const document of result.rows) await removeDocument(config, job.kbSlug, document.id);
  await context.query(`DELETE FROM "KnowledgeDocument" WHERE "sourceId" = $1 AND "externalId" = $2`, [job.sourceId, externalId]);
}

async function completeWorkItem(context: Pool, job: JobContext, workItem: WorkItemContext) {
  const client = await context.connect();
  try {
    await client.query("BEGIN");
    if (job.sourceConnector === "youtube") {
      const active = await client.query(`SELECT job.id FROM "IngestionJob" job
        JOIN "KnowledgeSource" source ON source.id = job."sourceId"
        JOIN "YouTubeSourceConfig" config ON config."sourceId" = source.id
        JOIN "YouTubeConnection" connection ON connection.id = config."connectionId"
        WHERE job.id = $1 AND job.status = 'running' AND connection.status = 'active' AND source.status <> 'expiring'
        FOR SHARE OF connection, source, job`, [job.jobId]);
      if (!active.rowCount) throw new YouTubeError("CONNECTION_INACTIVE", "YouTube import stopped because its connection is no longer active");
    }
    const completed = await client.query(`UPDATE "IngestionWorkItem" SET status = 'succeeded', "processedAt" = NOW(),
      "leaseExpiresAt" = NULL, error = NULL, "updatedAt" = NOW() WHERE id = $1 AND "jobId" = $2 AND status = 'running' RETURNING id`,
      [workItem.id, job.jobId]);
    if (completed.rowCount === 1) await client.query(`UPDATE "IngestionJob" SET "itemsProcessed" = "itemsProcessed" + 1, "updatedAt" = NOW() WHERE id = $1`, [job.jobId]);
    if (job.sourceConnector === "youtube" && workItem.kind === "segment") {
      await client.query(`UPDATE "IngestionWorkItem" publisher SET status = 'queued', "updatedAt" = NOW()
        WHERE publisher."jobId" = $1 AND publisher.kind = 'publish' AND publisher.status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM "IngestionWorkItem" segment
            WHERE segment."jobId" = $1 AND segment.kind = 'segment' AND segment.status <> 'succeeded')`, [job.jobId]);
    }
    const incomplete = await client.query(`SELECT 1 FROM "IngestionWorkItem" WHERE "jobId" = $1 AND status <> 'succeeded' LIMIT 1`, [job.jobId]);
    if (!incomplete.rowCount) {
      await client.query(`UPDATE "IngestionJob" SET status = 'succeeded', "finishedAt" = NOW(), "activeKey" = NULL, error = NULL, "updatedAt" = NOW() WHERE id = $1`, [job.jobId]);
      await client.query(`UPDATE "KnowledgeSource" SET status = 'active', "lastSyncedAt" = NOW(), error = NULL, "updatedAt" = NOW() WHERE id = $1`, [job.sourceId]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function recordFailure(context: Pool, job: JobContext, workItemId: string, error: unknown, terminal: boolean) {
  const message = job.sourceConnector === "youtube" && !(error instanceof YouTubeError)
    ? "YouTube import failed. Please retry." : error instanceof Error ? error.message : "Ingestion failed";
  const client = await context.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE "IngestionWorkItem" SET status = $3, error = $4,
      "processedAt" = CASE WHEN $3 = 'failed' THEN NOW() ELSE NULL END, "leaseExpiresAt" = NULL, "updatedAt" = NOW()
      WHERE id = $1 AND "jobId" = $2 AND status = 'running'`, [workItemId, job.jobId, terminal ? "failed" : "queued", message]);
    if (terminal) {
      await client.query(`UPDATE "IngestionJob" SET status = 'failed', error = $2, "finishedAt" = NOW(), "activeKey" = NULL, "updatedAt" = NOW() WHERE id = $1`, [job.jobId, message]);
      await client.query(`UPDATE "KnowledgeSource" SET status = 'failed', error = $2, "updatedAt" = NOW()
        WHERE id = $1 AND ($3 <> 'youtube' OR status <> 'expiring')`, [job.sourceId, message, job.sourceConnector]);
    } else {
      await client.query(`UPDATE "IngestionJob" SET status = 'running', error = $2, "finishedAt" = NULL, "updatedAt" = NOW() WHERE id = $1`, [job.jobId, message]);
    }
    await client.query("COMMIT");
  } catch (updateError) {
    await client.query("ROLLBACK");
    throw updateError;
  } finally {
    client.release();
  }
}

async function processRecord(record: SqsRecord, config: PipelineConfig) {
  const startedAt = Date.now();
  const message = parseQueueMessage(record.body);
  const context = database(config);
  const { job, workItem } = await loadContext(context, message);
  if (["failed", "succeeded"].includes(job.status)) return;
  if (!(await claimWorkItem(context, job.jobId, workItem.id))) {
    await enqueueQueuedWorkItems(context, config, job.jobId);
    return;
  }
  await startJob(context, job);
  console.info(`[JOB:${job.sourceConnector}-sync] start jobId=${job.jobId} sourceId=${job.sourceId} workItemId=${workItem.id} kind=${workItem.kind}`);
  try {
    if (job.sourceConnector === "youtube") {
      await processYouTubeImport(context, config, job, workItem);
      await completeWorkItem(context, job, workItem);
      await enqueueQueuedWorkItems(context, config, job.jobId);
      console.info(`[JOB:youtube-sync] complete jobId=${job.jobId} workItemId=${workItem.id} kind=${workItem.kind} elapsedMs=${Date.now() - startedAt}`);
      return;
    }
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
    for (const childId of children) await enqueueNotionChild(context, config, job, workItem, childId);
    const content = createSourceCleaner("notion").clean(rawMarkdown);
    if (content) {
      const markdown = `# ${page.title}\n\n${content}`;
      const document = await upsertDocument(context, job, workItem, page.title, markdown, page.lastEditedAt);
      await writeMarkdown(context, config, job, document, markdown);
      await context.query(`UPDATE "KnowledgeDocument" SET status = 'digesting', error = NULL, "updatedAt" = NOW() WHERE id = $1`, [document.id]);
      const prepared = await new ChunkingService().prepare("notion", { text: markdown, pageTitle: page.title });
      const chunks = await classifySections(context, config, prepared.sourceText, prepared);
      const chunkCount = await indexDocument(config, job.kbSlug, document.id, document.slug, chunks,
        { pageId: page.id, pageTitle: prepared.pageTitle, chunkingVersion: prepared.chunkingVersion });
      await context.query(`UPDATE "KnowledgeDocument" SET status = $2, error = $3, "indexedAt" = $4, "updatedAt" = NOW() WHERE id = $1`,
        [document.id, chunkCount ? "indexed" : "failed", chunkCount ? null : "No content indexed", chunkCount ? new Date() : null]);
    } else {
      await removeEmptyDocument(context, config, job, workItem.workKey);
    }
    await completeWorkItem(context, job, workItem);
    console.info(`[JOB:notion-sync] complete jobId=${job.jobId} workItemId=${workItem.id} elapsedMs=${Date.now() - startedAt}`);
  } catch (error) {
    const receiveCount = Number(record.attributes?.ApproximateReceiveCount ?? "1");
    const permanent = error instanceof YouTubeError && !error.retryable;
    const terminal = permanent || receiveCount >= config.maxReceiveCount;
    await recordFailure(context, job, workItem.id, error, terminal);
    if (job.sourceConnector === "youtube" && error instanceof YouTubeError
      && ["NOT_FOUND", "NOT_OWNED", "PERMISSION_DENIED", "NO_ENGLISH_CAPTIONS"].includes(error.code)) {
      await context.query(`UPDATE "KnowledgeSource" SET status = 'unavailable' WHERE id = $1 AND status <> 'expiring'`, [job.sourceId]);
    }
    const safeError = job.sourceConnector === "youtube" ? error instanceof YouTubeError ? error.code : "IMPORT_FAILED" : error instanceof Error ? error.message : String(error);
    console.error(`[JOB:${job.sourceConnector}-sync] failed jobId=${job.jobId} workItemId=${workItem.id} receiveCount=${receiveCount} terminal=${terminal} elapsedMs=${Date.now() - startedAt} error=${safeError}`);
    if (!permanent) throw error;
  }
}

/** Processes identifier-only work items; maintenance events remain disabled by default. */
export async function handler(event: SqsEvent | { action: "youtube-maintenance" }): Promise<SqsResult> {
  const config = loadConfig();
  if ("action" in event && event.action === "youtube-maintenance") {
    if (!config.youtubeMaintenanceEnabled) {
      console.info("[JOB:youtube-maintenance] skipped reason=disabled");
      return { batchItemFailures: [] };
    }
    await maintainYouTubeImports(database(config), config);
    return { batchItemFailures: [] };
  }
  if (!("Records" in event)) throw new Error("Unsupported ingestion event");
  const failures: { itemIdentifier: string }[] = [];
  await Promise.all(event.Records.map(async (record) => {
    try {
      await processRecord(record, config);
    } catch {
      failures.push({ itemIdentifier: record.messageId });
    }
  }));
  return { batchItemFailures: failures };
}

export { parseQueueMessage } from "./message";

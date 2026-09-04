import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { Pool } from "pg";
import type { PipelineConfig } from "../../config";
import { identifierOnlyMessage } from "../../message";
import { removeDocumentStrict } from "../../knowledge";
import { youtubeClient } from "./processor";
import { googleRequest, youtubeConfig } from "../../../../shared/youtube/http.server";
import { decryptToken, tokenBinding } from "../../../../shared/youtube/tokens.server";
import { YouTubeError } from "../../../../shared/youtube/types";

type Connection = { id: string; orgId: string; userId: string; status: string; lastVerifiedAt: Date; updatedAt: Date; refreshTokenCiphertext: string | null; accessTokenCiphertext: string | null };

/** Waits out active page leases before retryable, tenant-scoped privacy cleanup. */
async function cleanupConnection(pool: Pool, config: PipelineConfig, connection: Connection, deadline: number) {
  await pool.query(`UPDATE "IngestionJob" SET status = 'failed', stage = NULL, "activeKey" = NULL,
    error = 'YouTube connection disconnected', "finishedAt" = NOW(), "updatedAt" = NOW()
    WHERE status IN ('queued','running') AND "sourceId" IN (SELECT source.id FROM "KnowledgeSource" source
      JOIN "YouTubeSourceConfig" config ON config."sourceId" = source.id
      WHERE config."connectionId" = $1 AND source."orgId" = $2)`, [connection.id, connection.orgId]);
  const running = await pool.query(`SELECT item.id FROM "IngestionWorkItem" item
    JOIN "IngestionJob" job ON job.id = item."jobId" JOIN "KnowledgeSource" source ON source.id = job."sourceId"
    JOIN "YouTubeSourceConfig" config ON config."sourceId" = source.id
    WHERE config."connectionId" = $1 AND item.status = 'running' AND item."leaseExpiresAt" > NOW() LIMIT 1`, [connection.id]);
  if (running.rowCount) return;
  const ciphertext = connection.refreshTokenCiphertext ?? connection.accessTokenCiphertext;
  let revocationError: unknown;
  if (ciphertext) {
    try {
      const scope = { connectionId: connection.id, orgId: connection.orgId, userId: connection.userId };
      const token = decryptToken(ciphertext, youtubeConfig().encryptionKey, tokenBinding(scope));
      await googleRequest("token-revoke", "https://oauth2.googleapis.com/revoke", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }),
      }, 64_000);
      await pool.query(`UPDATE "YouTubeConnection" SET "accessTokenCiphertext" = NULL, "refreshTokenCiphertext" = NULL,
        "tokenExpiresAt" = NULL WHERE id = $1 AND status = 'disconnecting'`, [connection.id]);
    } catch (error) { revocationError = error; }
  }
  const documents = await pool.query<Document>(`
    SELECT document.id, kb.slug AS "kbSlug", document."s3SourceKey", document."s3MarkdownKey", document."s3QuestionsKey"
    FROM "KnowledgeDocument" document JOIN "KnowledgeSource" source ON source.id = document."sourceId"
    JOIN "KnowledgeBase" kb ON kb.id = document."kbId" AND kb."orgId" = source."orgId"
    JOIN "YouTubeSourceConfig" config ON config."sourceId" = source.id
    WHERE config."connectionId" = $1 AND source."orgId" = $2 LIMIT 50`, [connection.id, connection.orgId]);
  if (!(await deleteStoredDocuments(pool, config, connection.orgId, documents.rows, deadline))) return;
  if (revocationError) throw revocationError;
  const remaining = await pool.query(`SELECT document.id FROM "KnowledgeDocument" document
    JOIN "KnowledgeSource" source ON source.id = document."sourceId"
    JOIN "YouTubeSourceConfig" config ON config."sourceId" = source.id WHERE config."connectionId" = $1 LIMIT 1`, [connection.id]);
  if (!remaining.rowCount) {
    await pool.query(`DELETE FROM "KnowledgeSource" source USING "YouTubeSourceConfig" config
      WHERE config."sourceId" = source.id AND config."connectionId" = $1 AND source."orgId" = $2`, [connection.id, connection.orgId]);
    await pool.query(`DELETE FROM "YouTubeConnection" WHERE id = $1 AND status = 'disconnecting'`, [connection.id]);
  }
}

type Document = { id: string; kbSlug: string; s3SourceKey: string | null; s3MarkdownKey: string | null; s3QuestionsKey: string | null };

async function deleteStoredDocuments(pool: Pool, config: PipelineConfig, orgId: string, documents: Document[], deadline: number) {
  const startedAt = Date.now();
  console.info(`[DB:youtube-cleanup] start count=${documents.length}`);
  const s3 = new S3Client({ region: config.awsRegion });
  for (const document of documents) {
    if (Date.now() > deadline) return false;
    await removeDocumentStrict(config, document.kbSlug, document.id);
    const prefix = `${config.s3BasePrefix}/${orgId}/${document.kbSlug}/${document.id}/`;
    if (![document.s3SourceKey, document.s3MarkdownKey, document.s3QuestionsKey].every((key) => !key || key === "pending" || key.startsWith(prefix))) {
      throw new Error("YouTube cleanup refused a key outside the document prefix");
    }
    let continuationToken: string | undefined;
    do {
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: config.s3Bucket, Prefix: prefix, ContinuationToken: continuationToken }));
      const objects = (listed.Contents ?? []).flatMap((entry) => entry.Key ? [{ Key: entry.Key }] : []);
      if (objects.length) await s3.send(new DeleteObjectsCommand({ Bucket: config.s3Bucket, Delete: { Objects: objects, Quiet: true } }));
      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
    await pool.query(`DELETE FROM "KnowledgeDocument" WHERE id = $1`, [document.id]);
  }
  console.info(`[DB:youtube-cleanup] complete count=${documents.length} elapsedMs=${Date.now() - startedAt}`);
  return true;
}

/** Delete unavailable or unrefreshable copies before the API-data retention deadline. */
async function expireTranscripts(pool: Pool, config: PipelineConfig, deadline: number) {
  const sources = await pool.query<{ id: string; orgId: string }>(`SELECT source.id, source."orgId" FROM "KnowledgeSource" source
    JOIN "YouTubeSourceConfig" youtube ON youtube."sourceId" = source.id
    JOIN "YouTubeConnection" connection ON connection.id = youtube."connectionId"
    WHERE connection.status = 'active' AND (source.status IN ('unavailable','expiring')
      OR youtube."fetchedAt" < NOW() - INTERVAL '29 days') LIMIT 50`);
  for (const source of sources.rows) {
    if (Date.now() > deadline) return;
    const marked = await pool.query(`UPDATE "KnowledgeSource" source SET status = 'expiring' WHERE source.id = $1
      AND (source.status IN ('unavailable','expiring') OR EXISTS (SELECT 1 FROM "YouTubeSourceConfig" youtube
        WHERE youtube."sourceId" = source.id AND youtube."fetchedAt" < NOW() - INTERVAL '29 days')) RETURNING source.id`, [source.id]);
    if (!marked.rowCount) continue;
    await pool.query(`UPDATE "IngestionJob" SET status = 'failed', stage = NULL, "activeKey" = NULL,
      error = 'Stored YouTube transcript expired or is unavailable. Import again to refresh.', "finishedAt" = NOW()
      WHERE "sourceId" = $1 AND status IN ('queued','running')`, [source.id]);
    const running = await pool.query(`SELECT item.id FROM "IngestionWorkItem" item JOIN "IngestionJob" job ON job.id = item."jobId"
      WHERE job."sourceId" = $1 AND item.status = 'running' AND item."leaseExpiresAt" > NOW() LIMIT 1`, [source.id]);
    if (running.rowCount) continue;
    const documents = await pool.query<Document>(`SELECT document.id, kb.slug AS "kbSlug", document."s3SourceKey", document."s3MarkdownKey", document."s3QuestionsKey"
      FROM "KnowledgeDocument" document JOIN "KnowledgeBase" kb ON kb.id = document."kbId"
      WHERE document."sourceId" = $1 AND kb."orgId" = $2`, [source.id, source.orgId]);
    if (!(await deleteStoredDocuments(pool, config, source.orgId, documents.rows, deadline))) return;
    await pool.query(`UPDATE "YouTubeSourceConfig" SET "captionId" = NULL, "captionUpdatedAt" = NULL, "fetchedAt" = NULL WHERE "sourceId" = $1`, [source.id]);
    await pool.query(`UPDATE "KnowledgeSource" SET status = 'failed',
      error = 'Stored transcript removed. Import again to fetch current English captions.' WHERE id = $1`, [source.id]);
  }
}

/** Schedule every 15 minutes after deployment approval; never discovers new channel videos. */
export async function maintainYouTubeImports(pool: Pool, config: PipelineConfig) {
  const startedAt = Date.now();
  const deadline = startedAt + 240_000;
  console.info("[JOB:youtube-maintenance] start");
  let failures = 0;
  try {
    const connections = await pool.query<Connection>(`SELECT connection.* FROM "YouTubeConnection" connection
      WHERE status IN ('disconnecting','reconnect_required') OR "lastVerifiedAt" < NOW() - INTERVAL '1 day'
      ORDER BY CASE WHEN status = 'disconnecting' THEN 0 ELSE 1 END, "lastVerifiedAt" LIMIT 20`);
    for (const connection of connections.rows) {
      if (Date.now() > deadline) break;
      try {
        if (connection.status !== "disconnecting") {
          try {
            const member = await pool.query(`SELECT id FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`, [connection.userId, connection.orgId]);
            if (!member.rowCount) throw new YouTubeError("RECONNECT_REQUIRED", "Connection owner is no longer a member");
            await youtubeClient(pool).checkConnection({ connectionId: connection.id, orgId: connection.orgId, userId: connection.userId });
            await pool.query(`UPDATE "YouTubeConnection" SET "lastVerifiedAt" = NOW() WHERE id = $1 AND status = 'active'`, [connection.id]);
            continue;
          } catch (error) {
            const lostAccess = error instanceof YouTubeError && ["RECONNECT_REQUIRED", "WRONG_CHANNEL", "PERMISSION_DENIED"].includes(error.code);
            if (!lostAccess && Date.now() - new Date(connection.lastVerifiedAt).getTime() < 29 * 86_400_000) throw error;
            const marked = await pool.query(`UPDATE "YouTubeConnection" SET status = 'disconnecting', "refreshLeaseId" = NULL,
              "refreshLeaseExpiresAt" = NULL WHERE id = $1 AND "updatedAt" = $2 RETURNING id`, [connection.id, connection.updatedAt]);
            if (!marked.rowCount) continue;
          }
        }
        await cleanupConnection(pool, config, connection, deadline);
      } catch (error) {
        failures++;
        console.error(`[JOB:youtube-maintenance] connection-failed connectionId=${connection.id} code=${error instanceof YouTubeError ? error.code : "CLEANUP_FAILED"}`);
      }
    }
    await expireTranscripts(pool, config, deadline);
    // Refresh only explicitly imported videos, before the 30-day retention deadline.
    const due = await pool.query<{ id: string; externalId: string }>(`SELECT source.id, source."externalId" FROM "KnowledgeSource" source
      JOIN "YouTubeSourceConfig" youtube ON youtube."sourceId" = source.id
      JOIN "YouTubeConnection" connection ON connection.id = youtube."connectionId"
      WHERE source.connector = 'youtube' AND connection.status = 'active' AND source.status <> 'expiring' AND youtube."fetchedAt" < NOW() - INTERVAL '28 days'
      AND NOT EXISTS (SELECT 1 FROM "IngestionJob" job WHERE job."sourceId" = source.id
        AND (job."activeKey" IS NOT NULL OR job."createdAt" > NOW() - INTERVAL '6 hours')) LIMIT 20`);
    for (const source of due.rows) {
      if (Date.now() > deadline) break;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const current = await client.query(`SELECT source.id FROM "KnowledgeSource" source
          JOIN "YouTubeSourceConfig" youtube ON youtube."sourceId" = source.id
          JOIN "YouTubeConnection" connection ON connection.id = youtube."connectionId"
          WHERE source.id = $1 AND source.status <> 'expiring' AND connection.status = 'active'
            AND youtube."fetchedAt" < NOW() - INTERVAL '28 days' FOR UPDATE OF source`, [source.id]);
        if (!current.rowCount) {
          await client.query("COMMIT");
          continue;
        }
        const job = await client.query<{ id: string }>(`INSERT INTO "IngestionJob" (id,"sourceId","activeKey",status,stage,"itemsDiscovered","itemsProcessed","createdAt","updatedAt")
          VALUES ($1,$2,$3,'queued','queued',1,0,NOW(),NOW()) ON CONFLICT ("activeKey") DO NOTHING RETURNING id`, [crypto.randomUUID(), source.id, `${source.id}:${source.externalId}`]);
        if (job.rows[0]) await client.query(`INSERT INTO "IngestionWorkItem" (id,"jobId","workKey",kind,status,"createdAt","updatedAt")
          VALUES ($1,$2,$3,'resource','queued',NOW(),NOW())`, [crypto.randomUUID(), job.rows[0].id, source.externalId]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    }
    // Recover committed jobs whose first SQS publication failed or was interrupted.
    const pending = await pool.query<{ jobId: string; workItemId: string }>(`SELECT job.id AS "jobId", item.id AS "workItemId"
      FROM "IngestionWorkItem" item JOIN "IngestionJob" job ON job.id = item."jobId"
      JOIN "KnowledgeSource" source ON source.id = job."sourceId"
      JOIN "YouTubeSourceConfig" youtube ON youtube."sourceId" = source.id
      JOIN "YouTubeConnection" connection ON connection.id = youtube."connectionId"
      WHERE job.status = 'queued' AND item.status = 'queued' AND item."enqueuedAt" IS NULL AND connection.status = 'active' LIMIT 50`);
    const sqs = new SQSClient({ region: config.awsRegion });
    for (const message of pending.rows) {
      if (Date.now() > deadline) break;
      await sqs.send(new SendMessageCommand({ QueueUrl: config.queueUrl, MessageBody: identifierOnlyMessage(message) }));
      await pool.query(`UPDATE "IngestionWorkItem" SET "enqueuedAt" = NOW() WHERE id = $1`, [message.workItemId]);
    }
    await pool.query(`DELETE FROM "YouTubeOAuthState" WHERE "expiresAt" < NOW()`);
    if (failures) throw new Error("Some YouTube connections require another maintenance attempt");
    console.info(`[JOB:youtube-maintenance] complete elapsedMs=${Date.now() - startedAt}`);
  } catch (error) {
    console.error(`[JOB:youtube-maintenance] failed elapsedMs=${Date.now() - startedAt} code=${error instanceof YouTubeError ? error.code : "MAINTENANCE_FAILED"}`);
    throw error;
  }
}

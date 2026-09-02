import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Pool } from "pg";
import type { PipelineConfig } from "./config";
import { ChunkingService, YOUTUBE_CHUNKING_VERSION, type TranscriptSegment } from "./chunking";
import { classifySections, embedTexts, replaceDocumentVectors } from "./knowledge";
import type { PreparedChunk } from "./chunking/markdown";
import { createYouTubeClient } from "../../shared/youtube/client.server";
import { createConnectionStore } from "../../shared/youtube/connection-store.server";
import { youtubeConfig } from "../../shared/youtube/http.server";
import { YouTubeError, type ConnectionScope } from "../../shared/youtube/types";

const MAX_VIDEO_BATCH_SECONDS = 15 * 60;

export type YouTubeJob = {
  jobId: string; sourceId: string; orgId: string; kbId: string; kbSlug: string;
  youtubeConnectionId: string | null; connectionUserId: string | null; externalId: string;
};

export type YouTubeWorkItem = {
  id: string;
  workKey: string;
  parentWorkItemId: string | null;
  kind: string;
  payload: unknown;
};

type TranscriptArtifact = { version: 1; segments: TranscriptSegment[] };
type SegmentPayload = {
  batchIndex: number;
  rangeStartMs: number;
  rangeEndMs: number;
  segmentStartIndex: number;
  segmentEndIndex: number;
  transcriptKey: string;
  documentId: string;
  title: string;
  slug: string;
};
type PublishPayload = { documentId: string; title: string; slug: string; segmentCount: number };
type SegmentArtifact = { version: 1; batchIndex: number; chunks: PreparedChunk[]; vectors: number[][] };

/** pg adapter for the same connection/token implementation used by the web backend. */
export function youtubeClient(pool: Pool) {
  return createYouTubeClient(createConnectionStore(async <T>(sql: string, values: unknown[]) => (await pool.query(sql, values)).rows as T[]), youtubeConfig());
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid ingestion work payload");
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string) {
  if (typeof value[key] !== "string" || !value[key]) throw new Error(`Invalid work payload field: ${key}`);
  return value[key] as string;
}

function integerField(value: Record<string, unknown>, key: string) {
  if (!Number.isInteger(value[key]) || Number(value[key]) < 0) throw new Error(`Invalid work payload field: ${key}`);
  return Number(value[key]);
}

function segmentPayload(value: unknown): SegmentPayload {
  const data = object(value);
  const parsed = {
    batchIndex: integerField(data, "batchIndex"),
    rangeStartMs: integerField(data, "rangeStartMs"),
    rangeEndMs: integerField(data, "rangeEndMs"),
    segmentStartIndex: integerField(data, "segmentStartIndex"),
    segmentEndIndex: integerField(data, "segmentEndIndex"),
    transcriptKey: stringField(data, "transcriptKey"),
    documentId: stringField(data, "documentId"),
    title: stringField(data, "title"),
    slug: stringField(data, "slug"),
  };
  if (parsed.rangeEndMs <= parsed.rangeStartMs || parsed.segmentEndIndex <= parsed.segmentStartIndex) {
    throw new Error("Invalid YouTube segment range");
  }
  return parsed;
}

function publishPayload(value: unknown): PublishPayload {
  const data = object(value);
  return {
    documentId: stringField(data, "documentId"),
    title: stringField(data, "title"),
    slug: stringField(data, "slug"),
    segmentCount: integerField(data, "segmentCount"),
  };
}

function transcriptArtifact(value: unknown): TranscriptArtifact {
  const data = object(value);
  if (data.version !== 1 || !Array.isArray(data.segments)) throw new Error("Invalid stored YouTube transcript");
  const segments = data.segments.map((entry) => {
    const segment = object(entry);
    if (typeof segment.text !== "string" || !Number.isFinite(segment.startSeconds)
      || !Number.isFinite(segment.endSeconds) || Number(segment.endSeconds) < Number(segment.startSeconds)) {
      throw new Error("Invalid stored YouTube transcript segment");
    }
    return { text: segment.text, startSeconds: Number(segment.startSeconds), endSeconds: Number(segment.endSeconds) };
  });
  return { version: 1, segments };
}

function segmentArtifact(value: unknown): SegmentArtifact {
  const data = object(value);
  if (data.version !== 1 || !Array.isArray(data.chunks) || !Array.isArray(data.vectors)) {
    throw new Error("Invalid stored YouTube segment artifact");
  }
  return { version: 1, batchIndex: integerField(data, "batchIndex"), chunks: data.chunks as PreparedChunk[], vectors: data.vectors as number[][] };
}

async function assertActive(pool: Pool, job: YouTubeJob) {
  const result = await pool.query(`SELECT job.id FROM "IngestionJob" job
    JOIN "KnowledgeSource" source ON source.id = job."sourceId"
    JOIN "YouTubeSourceConfig" config ON config."sourceId" = source.id
    JOIN "YouTubeConnection" connection ON connection.id = config."connectionId" AND connection."orgId" = source."orgId"
    JOIN "member" member ON member."userId" = connection."userId" AND member."organizationId" = connection."orgId"
    WHERE job.id = $1 AND source.id = $2 AND source."orgId" = $3 AND source."externalId" = $4
      AND connection.id = $5 AND connection."userId" = $6 AND connection.status = 'active' AND job.status = 'running'
      AND source.status <> 'expiring'`,
    [job.jobId, job.sourceId, job.orgId, job.externalId, job.youtubeConnectionId, job.connectionUserId]);
  if (!result.rowCount) throw new YouTubeError("CONNECTION_INACTIVE", "YouTube import stopped because its connection is no longer active");
}

export function partitionTranscript(segments: TranscriptSegment[]) {
  const batches: { startIndex: number; endIndex: number; startSeconds: number; endSeconds: number }[] = [];
  let startIndex = 0;
  while (startIndex < segments.length) {
    const startSeconds = segments[startIndex].startSeconds;
    let endIndex = startIndex + 1;
    while (endIndex < segments.length && segments[endIndex].endSeconds - startSeconds <= MAX_VIDEO_BATCH_SECONDS) endIndex++;
    const endSeconds = segments[endIndex - 1].endSeconds;
    if (endSeconds - startSeconds > MAX_VIDEO_BATCH_SECONDS) throw new Error("A single caption exceeds the maximum video batch duration");
    batches.push({ startIndex, endIndex, startSeconds, endSeconds });
    startIndex = endIndex;
  }
  return batches;
}

async function prepareVideo(pool: Pool, config: PipelineConfig, job: YouTubeJob, workItem: YouTubeWorkItem) {
  if (!job.youtubeConnectionId || !job.connectionUserId || workItem.parentWorkItemId || workItem.workKey !== job.externalId) {
    throw new YouTubeError("OWNER_CONNECTION_REQUIRED", "Reconnect and import this video through its owner's YouTube connection");
  }
  await assertActive(pool, job);
  await pool.query(`UPDATE "IngestionJob" SET stage = 'fetching_captions', "updatedAt" = NOW() WHERE id = $1 AND status = 'running'`, [job.jobId]);
  const scope: ConnectionScope = { connectionId: job.youtubeConnectionId, orgId: job.orgId, userId: job.connectionUserId };
  const transcript = await youtubeClient(pool).fetchOwnedEnglishTranscript(scope, job.externalId);
  const document = await pool.query<{ id: string; slug: string }>(`INSERT INTO "KnowledgeDocument"
    (id,"kbId","sourceId","externalId",slug,title,ext,size,"s3SourceKey","s3MarkdownKey",status,"externalUpdatedAt","createdAt","updatedAt")
    VALUES ($1,$2,$3,$4,$5,$6,'md',$7,'pending','pending','digesting',$8,NOW(),NOW())
    ON CONFLICT ("sourceId","externalId") DO UPDATE SET title = EXCLUDED.title, size = EXCLUDED.size,
      status = 'digesting', error = NULL, "externalUpdatedAt" = EXCLUDED."externalUpdatedAt", "updatedAt" = NOW()
    RETURNING id, slug`, [crypto.randomUUID(), job.kbId, job.sourceId, job.externalId,
      `youtube_${job.externalId}.md`, transcript.title, Buffer.byteLength(transcript.markdown), new Date(transcript.captionUpdatedAt)]);
  const stored = document.rows[0];
  const prefix = `${config.s3BasePrefix}/${job.orgId}/${job.kbSlug}/${stored.id}`;
  const transcriptKey = `${prefix}/transcript.json`;
  const markdownKey = `${prefix}/content.md`;
  const artifact: TranscriptArtifact = { version: 1, segments: transcript.segments };
  const s3 = new S3Client({ region: config.awsRegion });
  const storedAt = Date.now();
  console.info(`[DB:youtube-transcript] start documentId=${stored.id} segments=${transcript.segments.length}`);
  await Promise.all([
    s3.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: transcriptKey, Body: JSON.stringify(artifact), ContentType: "application/json" })),
    s3.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: markdownKey, Body: transcript.markdown, ContentType: "text/markdown; charset=utf-8" })),
  ]);
  await pool.query(`UPDATE "KnowledgeDocument" SET "s3SourceKey" = $2, "s3MarkdownKey" = $3, "updatedAt" = NOW() WHERE id = $1`, [stored.id, transcriptKey, markdownKey]);
  await pool.query(`UPDATE "YouTubeSourceConfig" SET "captionId" = $2, "captionUpdatedAt" = $3, "fetchedAt" = NOW() WHERE "sourceId" = $1`,
    [job.sourceId, transcript.captionId, new Date(transcript.captionUpdatedAt)]);
  console.info(`[DB:youtube-transcript] complete documentId=${stored.id} elapsedMs=${Date.now() - storedAt}`);
  const batches = partitionTranscript(transcript.segments);
  if (!batches.length) throw new YouTubeError("EMPTY_TRANSCRIPT", "No usable English transcript content was found");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let discovered = 0;
    for (const [batchIndex, batch] of batches.entries()) {
      const payload: SegmentPayload = {
        batchIndex, rangeStartMs: Math.floor(batch.startSeconds * 1000), rangeEndMs: Math.ceil(batch.endSeconds * 1000),
        segmentStartIndex: batch.startIndex, segmentEndIndex: batch.endIndex, transcriptKey,
        documentId: stored.id, title: transcript.title, slug: stored.slug,
      };
      const inserted = await client.query(`INSERT INTO "IngestionWorkItem"
        (id,"jobId","workKey","parentWorkItemId",kind,payload,status,"createdAt","updatedAt")
        VALUES ($1,$2,$3,$4,'segment',$5,'queued',NOW(),NOW())
        ON CONFLICT ("jobId","workKey") DO UPDATE SET payload = EXCLUDED.payload, "updatedAt" = NOW()
        WHERE "IngestionWorkItem".status IN ('pending','queued') RETURNING (xmax = 0) AS inserted`,
        [crypto.randomUUID(), job.jobId, `${job.externalId}#segment-${String(batchIndex).padStart(4, "0")}`, workItem.id, JSON.stringify(payload)]);
      if (inserted.rows[0]?.inserted) discovered++;
    }
    const publish: PublishPayload = { documentId: stored.id, title: transcript.title, slug: stored.slug, segmentCount: batches.length };
    const inserted = await client.query(`INSERT INTO "IngestionWorkItem"
      (id,"jobId","workKey","parentWorkItemId",kind,payload,status,"createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,'publish',$5,'pending',NOW(),NOW())
      ON CONFLICT ("jobId","workKey") DO UPDATE SET payload = EXCLUDED.payload, "updatedAt" = NOW()
      WHERE "IngestionWorkItem".status = 'pending' RETURNING (xmax = 0) AS inserted`,
      [crypto.randomUUID(), job.jobId, `${job.externalId}#publish`, workItem.id, JSON.stringify(publish)]);
    if (inserted.rows[0]?.inserted) discovered++;
    if (discovered) await client.query(`UPDATE "IngestionJob" SET "itemsDiscovered" = "itemsDiscovered" + $2, stage = 'processing_segments', "updatedAt" = NOW() WHERE id = $1`, [job.jobId, discovered]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function processSegment(pool: Pool, config: PipelineConfig, job: YouTubeJob, workItem: YouTubeWorkItem) {
  await assertActive(pool, job);
  const payload = segmentPayload(workItem.payload);
  const s3 = new S3Client({ region: config.awsRegion });
  const object = await s3.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: payload.transcriptKey }));
  const transcript = transcriptArtifact(JSON.parse((await object.Body?.transformToString("utf-8")) ?? ""));
  const segments = transcript.segments.slice(payload.segmentStartIndex, payload.segmentEndIndex);
  if (!segments.length) throw new Error("YouTube segment contains no transcript cues");
  const prepared = await new ChunkingService().prepare("youtube", { pageTitle: payload.title, segments });
  const chunks = await classifySections(pool, config, prepared.sourceText, prepared);
  if (!chunks.length) throw new YouTubeError("EMPTY_TRANSCRIPT", "No usable English transcript content was indexed");
  const vectors = await embedTexts(config, chunks.map((chunk) => chunk.text));
  const artifact: SegmentArtifact = { version: 1, batchIndex: payload.batchIndex, chunks, vectors };
  const body = JSON.stringify(artifact);
  const hash = createHash("sha256").update(body).digest("hex");
  const key = `${config.s3BasePrefix}/${job.orgId}/${job.kbSlug}/${payload.documentId}/jobs/${job.jobId}/segment-${String(payload.batchIndex).padStart(4, "0")}.json`;
  const startedAt = Date.now();
  console.info(`[JOB:youtube-segment] store-start jobId=${job.jobId} batch=${payload.batchIndex} chunks=${chunks.length}`);
  await s3.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: key, Body: body, ContentType: "application/json" }));
  await pool.query(`UPDATE "IngestionWorkItem" SET "artifactKey" = $2, "artifactHash" = $3, "chunkCount" = $4, "updatedAt" = NOW()
    WHERE id = $1 AND status = 'running'`, [workItem.id, key, hash, chunks.length]);
  console.info(`[JOB:youtube-segment] store-complete jobId=${job.jobId} batch=${payload.batchIndex} chunks=${chunks.length} elapsedMs=${Date.now() - startedAt}`);
}

async function publishVideo(pool: Pool, config: PipelineConfig, job: YouTubeJob, workItem: YouTubeWorkItem) {
  await assertActive(pool, job);
  const payload = publishPayload(workItem.payload);
  const rows = await pool.query<{ artifactKey: string; artifactHash: string; workKey: string }>(`SELECT "artifactKey", "artifactHash", "workKey"
    FROM "IngestionWorkItem" WHERE "jobId" = $1 AND kind = 'segment' AND status = 'succeeded' ORDER BY "workKey"`, [job.jobId]);
  if (rows.rowCount !== payload.segmentCount || rows.rows.some((row) => !row.artifactKey || !row.artifactHash)) {
    throw new Error("YouTube publication is missing successful segment artifacts");
  }
  const s3 = new S3Client({ region: config.awsRegion });
  const chunks: PreparedChunk[] = [];
  const vectors: number[][] = [];
  for (const row of rows.rows) {
    const object = await s3.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: row.artifactKey }));
    const body = (await object.Body?.transformToString("utf-8")) ?? "";
    if (createHash("sha256").update(body).digest("hex") !== row.artifactHash) throw new Error("YouTube segment artifact checksum mismatch");
    const artifact = segmentArtifact(JSON.parse(body));
    chunks.push(...artifact.chunks);
    vectors.push(...artifact.vectors);
  }
  await pool.query(`UPDATE "IngestionJob" SET stage = 'publishing' WHERE id = $1 AND status = 'running'`, [job.jobId]);
  const count = await replaceDocumentVectors(config, job.kbSlug, payload.documentId, payload.slug, chunks, vectors,
    { pageId: job.externalId, pageTitle: payload.title, chunkingVersion: YOUTUBE_CHUNKING_VERSION });
  if (!count) throw new YouTubeError("EMPTY_TRANSCRIPT", "No usable English transcript content was indexed");
  await pool.query(`UPDATE "KnowledgeDocument" SET status = 'indexed', "indexedAt" = NOW(), error = NULL, "updatedAt" = NOW() WHERE id = $1`, [payload.documentId]);
  await pool.query(`UPDATE "IngestionJob" SET stage = 'ready' WHERE id = $1 AND status = 'running'`, [job.jobId]);
}

/** Dispatches one connector-neutral work item for an owned YouTube import. */
export async function processYouTubeImport(pool: Pool, config: PipelineConfig, job: YouTubeJob, workItem: YouTubeWorkItem) {
  if (workItem.kind === "resource") return prepareVideo(pool, config, job, workItem);
  if (workItem.kind === "segment") return processSegment(pool, config, job, workItem);
  if (workItem.kind === "publish") return publishVideo(pool, config, job, workItem);
  throw new Error(`Unsupported YouTube work item kind: ${workItem.kind}`);
}

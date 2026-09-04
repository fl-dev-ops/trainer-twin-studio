import { createHash } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Pool } from "pg";
import { ChunkingService } from "../../chunking";
import type { PreparedChunk } from "../../chunking/markdown";
import type { PipelineConfig } from "../../config";
import { embedTexts, replaceDocumentVectors } from "../../knowledge";
import type { IngestionAdapter, JobContext, WorkItemContext } from "../types";
import {
  parsePublishPayload,
  parseQuestionSegmentArtifact,
  parseSegmentPayload,
  parseTranscriptArtifact,
  type PublishPayload,
  type QuestionSegmentArtifact,
  type SegmentPayload,
  type TranscriptArtifact,
  type YouTubeQuestionsArtifact,
} from "./artifacts";
import { YOUTUBE_CHUNKING_VERSION, type TranscriptSegment } from "./chunking/youtube";
import { extractYouTubeQuestions, YOUTUBE_QUESTION_EXTRACTION_VERSION } from "./questions";
import { createYouTubeClient } from "../../../../shared/youtube/client.server";
import { createConnectionStore } from "../../../../shared/youtube/connection-store.server";
import { youtubeConfig } from "../../../../shared/youtube/http.server";
import { YouTubeError, type ConnectionScope } from "../../../../shared/youtube/types";

const MAX_VIDEO_BATCH_SECONDS = 15 * 60;

/** pg adapter for the same connection/token implementation used by the web backend. */
export function youtubeClient(pool: Pool) {
  return createYouTubeClient(createConnectionStore(async <T>(sql: string, values: unknown[]) => (await pool.query(sql, values)).rows as T[]), youtubeConfig());
}

async function assertActive(pool: Pool, job: JobContext) {
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

async function prepareVideo(pool: Pool, config: PipelineConfig, job: JobContext, workItem: WorkItemContext) {
  if (!job.youtubeConnectionId || !job.connectionUserId || workItem.parentWorkItemId || workItem.workKey !== job.externalId) {
    throw new YouTubeError("OWNER_CONNECTION_REQUIRED", "Reconnect and import this video through its owner's YouTube connection");
  }
  await assertActive(pool, job);
  await pool.query(`UPDATE "IngestionJob" SET stage = 'fetching_captions', "updatedAt" = NOW() WHERE id = $1 AND status = 'running'`, [job.jobId]);
  const scope: ConnectionScope = { connectionId: job.youtubeConnectionId, orgId: job.orgId, userId: job.connectionUserId };
  const transcript = await youtubeClient(pool).fetchOwnedEnglishTranscript(scope, job.externalId);
  const artifact: TranscriptArtifact = { version: 1, segments: transcript.segments };
  const transcriptBody = JSON.stringify(artifact);
  const document = await pool.query<{ id: string; slug: string }>(`INSERT INTO "KnowledgeDocument"
    (id, "kbId", "sourceId", "externalId", slug, title, ext, size, "s3SourceKey", "s3MarkdownKey", status, "externalUpdatedAt", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NULL, 'digesting', $9, NOW(), NOW())
    ON CONFLICT ("sourceId", "externalId") DO UPDATE SET slug = EXCLUDED.slug, title = EXCLUDED.title, ext = EXCLUDED.ext,
      size = EXCLUDED.size, "s3MarkdownKey" = NULL, status = 'digesting', error = NULL,
      "externalUpdatedAt" = EXCLUDED."externalUpdatedAt", "updatedAt" = NOW()
    RETURNING id, slug`, [crypto.randomUUID(), job.kbId, job.sourceId, job.externalId,
      `youtube_${job.externalId}.json`, transcript.title, "json", Buffer.byteLength(transcriptBody), new Date(transcript.captionUpdatedAt)]);
  const stored = document.rows[0];
  const prefix = `${config.s3BasePrefix}/${job.orgId}/${job.kbSlug}/${stored.id}`;
  const transcriptKey = `${prefix}/transcript.json`;
  const s3 = new S3Client({ region: config.awsRegion });
  const storedAt = Date.now();
  console.info(`[EXT-API:s3-youtube-transcript] start documentId=${stored.id} segments=${transcript.segments.length}`);
  await Promise.all([
    s3.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: transcriptKey, Body: transcriptBody, ContentType: "application/json" })),
    s3.send(new DeleteObjectCommand({ Bucket: config.s3Bucket, Key: `${prefix}/content.md` })),
  ]);
  await pool.query(`UPDATE "KnowledgeDocument" SET "s3SourceKey" = $2, "updatedAt" = NOW() WHERE id = $1`, [stored.id, transcriptKey]);
  await pool.query(`UPDATE "YouTubeSourceConfig" SET "captionId" = $2, "captionUpdatedAt" = $3, "fetchedAt" = NOW() WHERE "sourceId" = $1`,
    [job.sourceId, transcript.captionId, new Date(transcript.captionUpdatedAt)]);
  console.info(`[EXT-API:s3-youtube-transcript] complete documentId=${stored.id} elapsedMs=${Date.now() - storedAt}`);
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

async function processSegment(pool: Pool, config: PipelineConfig, job: JobContext, workItem: WorkItemContext) {
  await assertActive(pool, job);
  const payload = parseSegmentPayload(workItem.payload);
  const s3 = new S3Client({ region: config.awsRegion });
  const object = await s3.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: payload.transcriptKey }));
  const transcript = parseTranscriptArtifact(JSON.parse((await object.Body?.transformToString("utf-8")) ?? ""));
  const segments = transcript.segments.slice(payload.segmentStartIndex, payload.segmentEndIndex);
  if (!segments.length) throw new Error("YouTube segment contains no transcript cues");
  const prepared = await new ChunkingService().prepare("youtube", { pageTitle: payload.title, segments });
  const sourceChunks = prepared.chunks.map((chunk, index) => {
    if (chunk.startSeconds === undefined || chunk.endSeconds === undefined) throw new Error("YouTube chunk is missing its timestamp range");
    return { id: `chunk-${index}`, text: chunk.text, startSeconds: chunk.startSeconds, endSeconds: chunk.endSeconds };
  });
  const questions = await extractYouTubeQuestions(pool, config, payload.title, sourceChunks);
  const vectors = await embedTexts(config, questions.map((question) => question.text));
  const artifact: QuestionSegmentArtifact = { version: 2, batchIndex: payload.batchIndex, questions, vectors };
  const body = JSON.stringify(artifact);
  const hash = createHash("sha256").update(body).digest("hex");
  const key = `${config.s3BasePrefix}/${job.orgId}/${job.kbSlug}/${payload.documentId}/jobs/${job.jobId}/segment-${String(payload.batchIndex).padStart(4, "0")}.json`;
  const startedAt = Date.now();
  console.info(`[JOB:youtube-segment] store-start jobId=${job.jobId} batch=${payload.batchIndex} questions=${questions.length}`);
  await s3.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: key, Body: body, ContentType: "application/json" }));
  await pool.query(`UPDATE "IngestionWorkItem" SET "artifactKey" = $2, "artifactHash" = $3, "chunkCount" = $4, "updatedAt" = NOW()
    WHERE id = $1 AND status = 'running'`, [workItem.id, key, hash, questions.length]);
  console.info(`[JOB:youtube-segment] store-complete jobId=${job.jobId} batch=${payload.batchIndex} questions=${questions.length} elapsedMs=${Date.now() - startedAt}`);
}

async function publishVideo(pool: Pool, config: PipelineConfig, job: JobContext, workItem: WorkItemContext) {
  await assertActive(pool, job);
  const payload = parsePublishPayload(workItem.payload);
  const rows = await pool.query<{ artifactKey: string; artifactHash: string; workKey: string }>(`SELECT "artifactKey", "artifactHash", "workKey"
    FROM "IngestionWorkItem" WHERE "jobId" = $1 AND kind = 'segment' AND status = 'succeeded' ORDER BY "workKey"`, [job.jobId]);
  if (rows.rowCount !== payload.segmentCount || rows.rows.some((row) => !row.artifactKey || !row.artifactHash)) {
    throw new Error("YouTube publication is missing successful segment artifacts");
  }
  const s3 = new S3Client({ region: config.awsRegion });
  const entries: { question: QuestionSegmentArtifact["questions"][number]; vector: number[]; order: number }[] = [];
  let order = 0;
  for (const row of rows.rows) {
    const object = await s3.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: row.artifactKey }));
    const body = (await object.Body?.transformToString("utf-8")) ?? "";
    if (createHash("sha256").update(body).digest("hex") !== row.artifactHash) throw new Error("YouTube segment artifact checksum mismatch");
    const artifact = parseQuestionSegmentArtifact(JSON.parse(body));
    for (const [index, question] of artifact.questions.entries()) entries.push({ question, vector: artifact.vectors[index], order: order++ });
  }
  entries.sort((left, right) => left.question.startSeconds - right.question.startSeconds
    || left.question.endSeconds - right.question.endSeconds || left.order - right.order);
  const unique = [] as typeof entries;
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.question.text.toLowerCase()}\u0000${entry.question.startSeconds}\u0000${entry.question.endSeconds}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  const questions = unique.map((entry) => entry.question);
  const vectors = unique.map((entry) => entry.vector);
  const sourceUrl = `https://www.youtube.com/watch?v=${job.externalId}`;
  const artifact: YouTubeQuestionsArtifact = {
    version: 1,
    videoId: job.externalId,
    title: payload.title,
    sourceUrl,
    extractionVersion: YOUTUBE_QUESTION_EXTRACTION_VERSION,
    chunkingVersion: YOUTUBE_CHUNKING_VERSION,
    questions,
  };
  const questionsKey = `${config.s3BasePrefix}/${job.orgId}/${job.kbSlug}/${payload.documentId}/jobs/${job.jobId}/questions.json`;
  await s3.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: questionsKey, Body: JSON.stringify(artifact), ContentType: "application/json" }));
  const chunks: PreparedChunk[] = questions.map((question) => ({
    text: question.text,
    sectionIds: [],
    topics: question.topics,
    proposedTopics: question.proposedTopics,
    startSeconds: question.startSeconds,
    endSeconds: question.endSeconds,
  }));
  await pool.query(`UPDATE "IngestionJob" SET stage = 'publishing' WHERE id = $1 AND status = 'running'`, [job.jobId]);
  const count = await replaceDocumentVectors(config, job.kbSlug, payload.documentId, payload.slug, chunks, vectors, {
    pageTitle: payload.title,
    chunkingVersion: YOUTUBE_CHUNKING_VERSION,
    kind: "youtube_question",
    videoId: job.externalId,
    extractionVersion: YOUTUBE_QUESTION_EXTRACTION_VERSION,
  });
  if (count !== questions.length) throw new Error("Published YouTube question count does not match the question artifact");
  await pool.query(`UPDATE "KnowledgeDocument" SET "s3QuestionsKey" = $2, "s3MarkdownKey" = NULL, status = 'indexed', "indexedAt" = NOW(), error = NULL, "updatedAt" = NOW() WHERE id = $1`,
    [payload.documentId, questionsKey]);
  await pool.query(`UPDATE "IngestionJob" SET stage = 'ready' WHERE id = $1 AND status = 'running'`, [job.jobId]);
}

/** Dispatches one connector-neutral work item for an owned YouTube import. */
export async function processYouTubeImport(pool: Pool, config: PipelineConfig, job: JobContext, workItem: WorkItemContext) {
  if (workItem.kind === "resource") return prepareVideo(pool, config, job, workItem);
  if (workItem.kind === "segment") return processSegment(pool, config, job, workItem);
  if (workItem.kind === "publish") return publishVideo(pool, config, job, workItem);
  throw new Error(`Unsupported YouTube work item kind: ${workItem.kind}`);
}

export const youtubeAdapter: IngestionAdapter = { process: processYouTubeImport };

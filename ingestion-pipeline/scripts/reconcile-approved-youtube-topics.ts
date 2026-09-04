import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CloudClient, type Collection } from "chromadb";
import { Pool } from "pg";
import { loadConfig } from "../src/config";
import type { YouTubeQuestionsArtifact } from "../src/adapters/youtube/artifacts";
import {
  artifactKeyFor,
  fetchDocumentRecords,
  parseQuestionsArtifact,
  reconcileArtifact,
  recordFingerprint,
  recordsNeedingUpdate,
  type RecordSnapshot,
} from "./lib/youtube-topic-reconciliation";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const positional = args.filter((argument) => argument !== "--apply");
if (positional.length > 1 || args.filter((argument) => argument === "--apply").length > 1
  || args.some((argument) => argument.startsWith("-") && argument !== "--apply")) {
  throw new Error("Usage: bun --env-file=<app.env> scripts/reconcile-approved-youtube-topics.ts [<kb>] [--apply]");
}
const targetKb = positional[0];
const config = loadConfig();
if (!config.chromaCloud) throw new Error("This reconciliation requires the ingestion Chroma Cloud configuration");
const databaseUrl = new URL(config.databaseUrl);
databaseUrl.searchParams.set("sslmode", "verify-full");
const pool = new Pool({ connectionString: databaseUrl.toString(), max: 1, connectionTimeoutMillis: 10_000 });
const chroma = new CloudClient(config.chromaCloud);
const s3 = new S3Client({ region: config.awsRegion });
const startedAt = Date.now();
let backupPath: string | undefined;

type StoredDocument = {
  id: string;
  s3QuestionsKey: string;
  kbSlug: string;
  orgId: string;
};

type Plan = {
  document: StoredDocument;
  collection: Collection;
  original: YouTubeQuestionsArtifact;
  updated: YouTubeQuestionsArtifact;
  nextKey: string;
  records: RecordSnapshot[];
  pendingRecords: number;
  promotedTopics: number;
  changedQuestions: number;
};

console.info(`[JOB:youtube-topic-reconcile] start kb=${targetKb ?? "all"} mode=${apply ? "apply" : "dry-run"}`);
try {
  const approved = await pool.query<{ slug: string }>('SELECT slug FROM "Topic" WHERE status = $1', ["approved"]);
  const approvedTopics = new Set(approved.rows.map((topic) => topic.slug));
  const documents = (await pool.query<StoredDocument>(`SELECT d.id, d."s3QuestionsKey", k.slug AS "kbSlug", k."orgId"
    FROM "KnowledgeDocument" d
    JOIN "KnowledgeBase" k ON k.id = d."kbId"
    JOIN "KnowledgeSource" s ON s.id = d."sourceId" AND s."orgId" = k."orgId" AND s."kbId" = k.id
    WHERE s.connector = 'youtube' AND d.status = 'indexed' AND d."s3QuestionsKey" IS NOT NULL
      AND ($1::text IS NULL OR k.slug = $1)
    ORDER BY k.slug, d.id`, [targetKb ?? null])).rows;
  if (targetKb && !documents.some((document) => document.kbSlug === targetKb)) {
    const exists = await pool.query('SELECT 1 FROM "KnowledgeBase" WHERE slug = $1', [targetKb]);
    if (!exists.rowCount) throw new Error(`Knowledge base not found: ${targetKb}`);
  }
  const affectedKbs = [...new Set(documents.map((document) => document.kbSlug))];
  if (affectedKbs.length) {
    const active = await pool.query(`SELECT 1 FROM "IngestionJob" job
      JOIN "KnowledgeSource" source ON source.id = job."sourceId"
      JOIN "KnowledgeBase" kb ON kb.id = source."kbId"
      WHERE kb.slug = ANY($1::text[]) AND job.status IN ('queued','running') LIMIT 1`, [affectedKbs]);
    if (active.rowCount) throw new Error("Wait for active ingestion jobs before reconciling YouTube topics");
  }

  const collections = new Map<string, Collection>();
  const plans: Plan[] = [];
  for (const document of documents) {
    const expectedPrefix = `${config.s3BasePrefix}/${document.orgId}/${document.kbSlug}/${document.id}/`;
    if (!document.s3QuestionsKey.startsWith(expectedPrefix)) throw new Error(`S3 storage scope mismatch for docId=${document.id}`);
    const object = await s3.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: document.s3QuestionsKey }));
    const body = await object.Body?.transformToString("utf-8");
    if (!body) throw new Error(`Missing questions artifact for docId=${document.id}`);
    const original = parseQuestionsArtifact(JSON.parse(body), document.id);
    const reconciliation = reconcileArtifact(original, approvedTopics);
    if (!reconciliation.changedQuestionIndices.size) continue;
    let collection = collections.get(document.kbSlug);
    if (!collection) {
      collection = await chroma.getCollection({
        name: `kb_${document.kbSlug}`,
        embeddingFunction: { generate: async () => { throw new Error("Embedding calls are forbidden during topic reconciliation"); } },
      });
      collections.set(document.kbSlug, collection);
    }
    const records = await fetchDocumentRecords(collection, document.id);
    const pendingRecords = recordsNeedingUpdate(document.id, records, original, reconciliation.artifact).length;
    plans.push({
      document,
      collection,
      original,
      updated: reconciliation.artifact,
      nextKey: artifactKeyFor(document.s3QuestionsKey, reconciliation.artifact),
      records,
      pendingRecords,
      promotedTopics: reconciliation.newlyApprovedTopicCount,
      changedQuestions: reconciliation.changedQuestionIndices.size,
    });
  }

  const changedQuestions = plans.reduce((total, plan) => total + plan.changedQuestions, 0);
  const promotedTopics = plans.reduce((total, plan) => total + plan.promotedTopics, 0);
  console.info(`[JOB:youtube-topic-reconcile] preflight documents=${plans.length} questions=${changedQuestions} topicAssignments=${promotedTopics} approvedCatalogTopics=${approvedTopics.size}`);
  if (apply && plans.length) {
    backupPath = await mkdtemp(join(tmpdir(), "trainertwin-youtube-topics-"));
    await writeFile(join(backupPath, "before.json"), JSON.stringify(plans.map((plan) => ({
      docId: plan.document.id,
      key: plan.document.s3QuestionsKey,
      artifact: plan.original,
      records: plan.records,
    }))), { mode: 0o600 });

    for (const plan of plans) {
      const documentStartedAt = Date.now();
      console.info(`[JOB:youtube-topic-reconcile] document-start docId=${plan.document.id} questions=${plan.changedQuestions} pendingRecords=${plan.pendingRecords}`);
      const current = await pool.query<{ s3QuestionsKey: string }>(`SELECT d."s3QuestionsKey" FROM "KnowledgeDocument" d
        WHERE d.id = $1 AND d."s3QuestionsKey" = $2
          AND NOT EXISTS (SELECT 1 FROM "IngestionJob" job WHERE job."sourceId" = d."sourceId" AND job.status IN ('queued','running'))`,
        [plan.document.id, plan.document.s3QuestionsKey]);
      if (current.rowCount !== 1) throw new Error(`Concurrent document change for docId=${plan.document.id}`);

      await s3.send(new PutObjectCommand({
        Bucket: config.s3Bucket,
        Key: plan.nextKey,
        Body: JSON.stringify(plan.updated),
        ContentType: "application/json",
      }));
      const currentRecords = await fetchDocumentRecords(plan.collection, plan.document.id);
      for (const [index, record] of currentRecords.entries()) {
        if (recordFingerprint(record, false) !== recordFingerprint(plan.records[index], false)) {
          throw new Error(`Concurrent Chroma content/vector change for docId=${plan.document.id}`);
        }
      }
      const updates = recordsNeedingUpdate(plan.document.id, currentRecords, plan.original, plan.updated);
      for (let start = 0; start < updates.length; start += 250) {
        const batch = updates.slice(start, start + 250);
        await plan.collection.update({ ids: batch.map((record) => record.id), metadatas: batch.map((record) => record.metadata) });
      }
      const verified = await fetchDocumentRecords(plan.collection, plan.document.id);
      if (recordsNeedingUpdate(plan.document.id, verified, plan.original, plan.updated).length) {
        throw new Error(`Chroma topic verification failed for docId=${plan.document.id}`);
      }
      const stored = await s3.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: plan.nextKey }));
      const storedBody = await stored.Body?.transformToString("utf-8");
      if (!storedBody || JSON.stringify(parseQuestionsArtifact(JSON.parse(storedBody), plan.document.id)) !== JSON.stringify(plan.updated)) {
        throw new Error(`S3 topic verification failed for docId=${plan.document.id}`);
      }
      const committed = await pool.query(`UPDATE "KnowledgeDocument" SET "s3QuestionsKey" = $2, "updatedAt" = NOW()
        WHERE id = $1 AND "s3QuestionsKey" = $3`, [plan.document.id, plan.nextKey, plan.document.s3QuestionsKey]);
      if (committed.rowCount !== 1) throw new Error(`Question artifact pointer changed for docId=${plan.document.id}`);
      console.info(`[JOB:youtube-topic-reconcile] document-complete docId=${plan.document.id} records=${updates.length} elapsedMs=${Date.now() - documentStartedAt}`);
    }
    await writeFile(join(backupPath, "summary.json"), JSON.stringify({
      documents: plans.length,
      changedQuestions,
      promotedTopics,
      contentAndVectorsUnchanged: true,
    }), { mode: 0o600 });
  }
  console.info(`[JOB:youtube-topic-reconcile] complete mode=${apply ? "apply" : "dry-run"} documents=${plans.length} backup=${backupPath ?? "none"} elapsedMs=${Date.now() - startedAt}`);
} catch (error) {
  console.error(`[JOB:youtube-topic-reconcile] failed backup=${backupPath ?? "none"} elapsedMs=${Date.now() - startedAt} error=${error instanceof Error ? error.name : "UnknownError"}`);
  process.exitCode = 1;
} finally {
  await pool.end();
  s3.destroy();
}

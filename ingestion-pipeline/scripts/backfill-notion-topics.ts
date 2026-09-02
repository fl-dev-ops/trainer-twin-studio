import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CloudClient, type Metadata } from "chromadb";
import { Pool } from "pg";
import { loadConfig } from "../src/config";
import { ChunkingService, type ChunkingResult } from "../src/chunking/service";
import { classifySections } from "../src/knowledge";

const [kb, ...flags] = process.argv.slice(2);
if (!kb || flags.some((flag) => flag !== "--apply") || flags.length > 1) {
  throw new Error("Usage: bun --env-file=<app.env> scripts/backfill-notion-topics.ts <kb> [--apply]");
}
const apply = flags.includes("--apply");
const config = loadConfig();
if (!config.chromaCloud) throw new Error("This backfill requires the ingestion Chroma Cloud configuration");
const databaseUrl = new URL(config.databaseUrl);
databaseUrl.searchParams.set("sslmode", "verify-full");
const pool = new Pool({ connectionString: databaseUrl.toString(), max: 1, connectionTimeoutMillis: 10_000 });
const chroma = new CloudClient(config.chromaCloud);
const s3 = new S3Client({ region: config.awsRegion });
const startedAt = Date.now();
let backupPath: string | undefined;

type StoredDocument = { id: string; title: string; externalId: string; s3MarkdownKey: string; orgId: string };
type RecordSnapshot = { id: string; text: string; embedding: number[]; metadata: Metadata };

/** Ignore metadata key order while checking every value, including vector coordinates. */
function fingerprint(record: RecordSnapshot, includeTopics = true): string {
  const metadata = Object.fromEntries(Object.entries(record.metadata)
    .filter(([key]) => includeTopics || key !== "topics").sort(([a], [b]) => a.localeCompare(b)));
  return createHash("sha256").update(JSON.stringify({ ...record, metadata })).digest("hex");
}

console.info(`[JOB:notion-topic-backfill] start kb=${kb} mode=${apply ? "apply" : "dry-run"}`);
try {
  const approved = await pool.query('SELECT slug FROM "Topic" WHERE status = $1', ["approved"]);
  if (!approved.rowCount) throw new Error("Approve catalog topics before backfilling");
  const active = await pool.query(`SELECT 1 FROM "IngestionJob" j
    JOIN "KnowledgeSource" s ON s.id = j."sourceId" JOIN "KnowledgeBase" k ON k.id = s."kbId"
    WHERE k.slug = $1 AND j.status IN ('queued', 'running') LIMIT 1`, [kb]);
  if (active.rowCount) throw new Error("Wait for active ingestion jobs before backfilling");
  const documents = await pool.query<StoredDocument>(`SELECT d.id, d.title, d."externalId", d."s3MarkdownKey", k."orgId"
    FROM "KnowledgeDocument" d JOIN "KnowledgeBase" k ON k.id = d."kbId"
    JOIN "KnowledgeSource" s ON s.id = d."sourceId" AND s."orgId" = k."orgId" AND s."kbId" = k.id
    WHERE k.slug = $1 AND s.type IN ('notion', 'notion_public') AND d.status = 'indexed' ORDER BY d.id`, [kb]);
  const collection = await chroma.getCollection({
    name: `kb_${kb}`,
    embeddingFunction: { generate: async () => { throw new Error("Embedding calls are forbidden during topic backfill"); } },
  });

  /** Fetch existing records only; never creates a collection or computes embeddings. */
  async function snapshot(ids?: string[]): Promise<RecordSnapshot[]> {
    const records: RecordSnapshot[] = [];
    for (let offset = 0; ; offset += 250) {
      const page = await collection.get({ ...(ids ? { ids } : {}), offset, limit: 250, include: ["documents", "metadatas", "embeddings"] });
      for (const [index, id] of page.ids.entries()) {
        const text = page.documents[index];
        const embedding = page.embeddings?.[index];
        const metadata = page.metadatas[index];
        if (typeof text !== "string" || !embedding?.length || !metadata) throw new Error("Incomplete Chroma snapshot");
        records.push({ id, text, embedding, metadata });
      }
      if (page.ids.length < 250) return records;
    }
  }

  const scanStartedAt = Date.now();
  console.info("[DB:notion-topic-backfill] preflight-start");
  const before = await snapshot();
  const plans: { document: StoredDocument; prepared: ChunkingResult; records: RecordSnapshot[] }[] = [];
  for (const document of documents.rows) {
    const records = before.filter((record) => record.metadata.docId === document.id)
      .sort((a, b) => Number(a.metadata.chunkIndex) - Number(b.metadata.chunkIndex));
    if (!records.length || records.every((record) => Array.isArray(record.metadata.topics) && record.metadata.topics.length)) continue;
    if (!document.s3MarkdownKey.startsWith(`${config.s3BasePrefix}/${document.orgId}/${kb}/${document.id}/`)) {
      throw new Error(`S3 storage scope mismatch for docId=${document.id}`);
    }
    const fetchStartedAt = Date.now();
    console.info(`[EXT-API:notion-topic-backfill] start docId=${document.id} operation=s3-get-markdown`);
    const object = await s3.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: document.s3MarkdownKey }));
    const markdown = await object.Body?.transformToString();
    if (!markdown) throw new Error(`Missing stored Markdown for docId=${document.id}`);
    console.info(`[EXT-API:notion-topic-backfill] complete docId=${document.id} elapsedMs=${Date.now() - fetchStartedAt}`);
    const prepared = await new ChunkingService().prepare("notion", { text: markdown, pageTitle: document.title });
    if (records.length !== prepared.chunks.length || records.some((record, index) =>
      record.id !== `${document.id}#${index}` || record.text !== prepared.chunks[index].text
      || record.metadata.chunkIndex !== index || record.metadata.chunkCount !== records.length
      || record.metadata.pageId !== document.externalId || record.metadata.chunkingVersion !== prepared.chunkingVersion
      || JSON.stringify(record.metadata.sectionIds) !== JSON.stringify(prepared.chunks[index].sectionIds))) {
      throw new Error(`Stored Markdown does not reproduce existing chunks for docId=${document.id}; no metadata written`);
    }
    plans.push({ document, prepared, records });
  }
  console.info(`[DB:notion-topic-backfill] preflight-complete collectionChunks=${before.length} documents=${plans.length} candidateChunks=${plans.reduce((sum, plan) => sum + plan.records.filter((record) => !Array.isArray(record.metadata.topics) || !record.metadata.topics.length).length, 0)} approvedTopics=${approved.rowCount} elapsedMs=${Date.now() - scanStartedAt}`);
  if (apply) {
    backupPath = await mkdtemp(join(tmpdir(), "trainertwin-notion-topics-"));
    await writeFile(join(backupPath, "before.json"), JSON.stringify({ collection: collection.name, records: before }), { mode: 0o600 });
    const expected = new Map(before.map((record) => [record.id, record]));
    let updatedChunks = 0;
    for (const { document, prepared, records } of plans) {
      const documentStartedAt = Date.now();
      console.info(`[JOB:notion-topic-backfill] document-start docId=${document.id} chunks=${records.length}`);
      const classified = await classifySections(pool, config, prepared.sourceText, prepared);
      const allowed = new Set((await pool.query<{ slug: string }>('SELECT slug FROM "Topic" WHERE status = $1', ["approved"])).rows.map((topic) => topic.slug));
      const updates = records.flatMap((record, index) => {
        if (Array.isArray(record.metadata.topics) && record.metadata.topics.length) return [];
        const topics = classified[index].topics;
        if (topics.some((topic) => !allowed.has(topic))) throw new Error("Classification contains an unapproved topic");
        return topics.length ? [{ ...record, metadata: { ...record.metadata, topics } }] : [];
      });
      await writeFile(join(backupPath, `${document.id}-topics.json`), JSON.stringify(updates.map(({ id, metadata }) => ({ id, topics: metadata.topics }))), { mode: 0o600 });
      const current = new Map((await snapshot(records.map((record) => record.id))).map((record) => [record.id, record]));
      if (current.size !== records.length || records.some((record) => !current.has(record.id) || fingerprint(current.get(record.id)!) !== fingerprint(record))) {
        throw new Error(`Concurrent Chroma change for docId=${document.id}; stopping backfill`);
      }
      if (updates.length) {
        const updateStartedAt = Date.now();
        console.info(`[DB:notion-topic-backfill] update-start docId=${document.id} count=${updates.length}`);
        for (let start = 0; start < updates.length; start += 250) {
          const batch = updates.slice(start, start + 250);
          await collection.update({ ids: batch.map((record) => record.id), metadatas: batch.map((record) => record.metadata) });
        }
        for (const record of updates) expected.set(record.id, record);
        updatedChunks += updates.length;
        console.info(`[DB:notion-topic-backfill] update-complete docId=${document.id} count=${updates.length} elapsedMs=${Date.now() - updateStartedAt}`);
      }
      console.info(`[JOB:notion-topic-backfill] document-complete docId=${document.id} newlyTaggedChunks=${updates.length} elapsedMs=${Date.now() - documentStartedAt}`);
    }
    const after = await snapshot();
    if (after.length !== before.length || after.some((record) => !expected.has(record.id) || fingerprint(record) !== fingerprint(expected.get(record.id)!))) {
      throw new Error("Post-update verification failed; retain the backup for recovery");
    }
    const originals = new Map(before.map((record) => [record.id, record]));
    if (after.some((record) => fingerprint(record, false) !== fingerprint(originals.get(record.id)!, false))) {
      throw new Error("Content, vectors, or non-topic metadata changed unexpectedly");
    }
    const summary = { collection: collection.name, totalChunks: after.length, updatedChunks, taggedChunks: after.filter((record) => Array.isArray(record.metadata.topics) && record.metadata.topics.length).length, contentAndVectorsUnchanged: true };
    await writeFile(join(backupPath, "summary.json"), JSON.stringify(summary), { mode: 0o600 });
    console.info(`[JOB:notion-topic-backfill] verified ${JSON.stringify(summary)}`);
  }
  console.info(`[JOB:notion-topic-backfill] complete mode=${apply ? "apply" : "dry-run"} backup=${backupPath ?? "none"} elapsedMs=${Date.now() - startedAt}`);
} catch (error) {
  console.error(`[JOB:notion-topic-backfill] failed backup=${backupPath ?? "none"} elapsedMs=${Date.now() - startedAt} error=${error instanceof Error ? error.name : "UnknownError"}`);
  process.exitCode = 1;
} finally {
  await pool.end();
  s3.destroy();
}

// Run with the app's env file. Default: dry run. --apply backs up then removes
// youtube_* vector sources, their documents/objects, and YouTube ingestion jobs.
// OAuth connections, other sources, and the SQS queue are never deleted.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CloudClient, type Collection } from "chromadb";
import { Pool } from "pg";
import { loadConfig } from "../src/config";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--apply") || args.length > 1) {
  throw new Error("Usage: bun --env-file=<app.env> scripts/cleanup-youtube.ts [--apply]");
}
const apply = args.includes("--apply");
const prefix = "youtube_";
const config = loadConfig();
if (!config.chromaCloud) throw new Error("This cleanup requires the app's Chroma Cloud configuration");
const databaseUrl = new URL(config.databaseUrl);
databaseUrl.searchParams.set("sslmode", "verify-full");
const pool = new Pool({ connectionString: databaseUrl.toString(), max: 1, connectionTimeoutMillis: 7_000 });
const chroma = new CloudClient(config.chromaCloud);
const startedAt = Date.now();
let backupPath: string | undefined;
let transaction = false;

type Document = {
  id: string; slug: string; sourceId: string | null; kb: string; orgId: string;
  s3SourceKey: string | null; s3MarkdownKey: string | null; s3QuestionsKey: string | null; status: string;
};
type VectorScope = { collection: Collection; ids: string[]; retainedIds: string[] };

/** Exact-object AWS operations; captured output never includes transcript bodies. */
function aws(args: string[]) {
  const startedAt = Date.now();
  const operation = args.slice(0, 2).join("/");
  console.info(`[EXT-API:youtube-cleanup] start operation=${operation}`);
  const result = spawnSync("aws", [...args, "--region", config.awsRegion, "--output", "json"], {
    encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) throw new Error(`AWS ${args.slice(0, 2).join(" ")} failed; check your AWS login and permissions`);
  console.info(`[EXT-API:youtube-cleanup] complete operation=${operation} elapsedMs=${Date.now() - startedAt}`);
  return result.stdout;
}

/** Scan metadata without using unsupported wildcard filters or creating collections. */
async function vectorScope(collection: Collection): Promise<VectorScope> {
  const ids: string[] = [];
  const retainedIds: string[] = [];
  for (let offset = 0; ; offset += 250) {
    const page = await collection.get({ include: ["metadatas"], limit: 250, offset });
    page.ids.forEach((id, index) => {
      const source = page.metadatas[index]?.source;
      (typeof source === "string" && source.startsWith(prefix) ? ids : retainedIds).push(id);
    });
    if (page.ids.length < 250) break;
  }
  return { collection, ids, retainedIds };
}

async function saveJson(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}

console.info(`[JOB:youtube-cleanup] start mode=${apply ? "apply" : "dry-run"}`);
try {
  // Locks keep enqueue/reindex operations from changing the selected DB rows
  // during an apply. No external data is deleted until every backup succeeds.
  await pool.query(apply ? "BEGIN" : "BEGIN READ ONLY");
  transaction = true;
  const sources = await pool.query(`SELECT * FROM "KnowledgeSource" WHERE connector = $1${apply ? " FOR UPDATE" : ""}`, ["youtube"]);
  const sourceIds = sources.rows.map((source) => source.id as string);
  const documents = await pool.query<Document>(`SELECT d.*, k.slug AS kb, k."orgId"
    FROM "KnowledgeDocument" d JOIN "KnowledgeBase" k ON k.id = d."kbId"
    WHERE starts_with(d.slug, $1) OR d."sourceId" = ANY($2::text[])${apply ? " FOR UPDATE OF d" : ""}`, [prefix, sourceIds]);
  if (documents.rows.some((doc) => !doc.slug.startsWith(prefix) || (doc.sourceId && !sourceIds.includes(doc.sourceId)))) {
    throw new Error("A document's source disagrees with the youtube_ prefix; review the scope manually");
  }
  if (documents.rows.some((doc) => doc.status === "digesting")) throw new Error("A YouTube document is currently being indexed");
  const jobs = await pool.query('SELECT * FROM "IngestionJob" WHERE "sourceId" = ANY($1::text[])', [sourceIds]);
  if (jobs.rows.some((job) => ["queued", "running"].includes(job.status))) throw new Error("Stop active YouTube imports before cleanup");
  const jobIds = jobs.rows.map((job) => job.id);
  const workItems = await pool.query('SELECT * FROM "IngestionWorkItem" WHERE "jobId" = ANY($1::text[])', [jobIds]);
  const bases = await pool.query<{ slug: string }>('SELECT slug FROM "KnowledgeBase" ORDER BY slug');
  const scopes: VectorScope[] = [];
  const scanStartedAt = Date.now();
  console.info("[DB:youtube-cleanup] scan-start");
  for (const base of bases.rows) {
    scopes.push(await vectorScope(await chroma.getCollection({ name: `kb_${base.slug}` })));
  }
  console.info(`[DB:youtube-cleanup] scan-complete elapsedMs=${Date.now() - scanStartedAt}`);
  const keys = new Set<string>();
  for (const doc of documents.rows) {
    const documentPrefix = `${config.s3BasePrefix}/${doc.orgId}/${doc.kb}/${doc.id}/`;
    for (const key of [doc.s3SourceKey, doc.s3MarkdownKey, doc.s3QuestionsKey]) {
      if (!key || key === "pending") continue;
      if (!key.startsWith(documentPrefix)) {
        throw new Error("An S3 key is outside its document's storage prefix; review it manually");
      }
    }
    let continuationToken: string | undefined;
    do {
      const output = aws(["s3api", "list-objects-v2", "--bucket", config.s3Bucket, "--prefix", documentPrefix,
        ...(continuationToken ? ["--continuation-token", continuationToken] : [])]);
      const listed = JSON.parse(output) as { Contents?: { Key?: string }[]; IsTruncated?: boolean; NextContinuationToken?: string };
      for (const object of listed.Contents ?? []) if (object.Key) keys.add(object.Key);
      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
  }
  const summary = {
    documents: documents.rows.length, sources: sources.rowCount, jobs: jobs.rowCount, workItems: workItems.rowCount,
    s3Objects: keys.size,
    collections: scopes.map(({ collection, ids, retainedIds }) => ({ name: collection.name, remove: ids.length, retain: retainedIds.length })),
  };
  console.info(`[JOB:youtube-cleanup] scope ${JSON.stringify(summary)}`);
  if (!apply) {
    await pool.query("ROLLBACK");
    transaction = false;
    console.info(`[JOB:youtube-cleanup] complete dry-run=true elapsedMs=${Date.now() - startedAt}`);
  } else {
    // Fail before any deletion if AWS authentication or object access is missing.
    for (const key of keys) aws(["s3api", "head-object", "--bucket", config.s3Bucket, "--key", key]);
    backupPath = await mkdtemp(join(tmpdir(), "trainertwin-youtube-cleanup-"));
    console.info("[JOB:youtube-cleanup] backup-start");
    await mkdir(join(backupPath, "vectors"));
    const objectKeys = [...keys];
    await saveJson(join(backupPath, "database.json"), {
      sources: sources.rows, documents: documents.rows, jobs: jobs.rows, workItems: workItems.rows,
    });
    await saveJson(join(backupPath, "manifest.json"), {
      createdAt: new Date().toISOString(), summary, bucket: config.s3Bucket,
      objects: objectKeys.map((key, index) => ({ key, file: `object-${index}` })),
      vectors: scopes.map(({ collection, ids }) => ({ collection: collection.name, ids })),
    });
    for (const [index, key] of objectKeys.entries()) {
      aws(["s3api", "get-object", "--bucket", config.s3Bucket, "--key", key, join(backupPath, `object-${index}`)]);
    }
    for (const [index, { collection, ids }] of scopes.entries()) {
      for (let start = 0; start < ids.length; start += 250) {
        const batch = ids.slice(start, start + 250);
        const snapshot = await collection.get({ ids: batch, include: ["embeddings", "documents", "metadatas"] });
        if (snapshot.ids.length !== batch.length || snapshot.embeddings?.some((embedding) => !embedding?.length) || !snapshot.embeddings?.length) {
          throw new Error("Vector backup is incomplete; no data was deleted");
        }
        await saveJson(join(backupPath, "vectors", `${index}-${start}.json`), snapshot);
      }
    }
    console.info(`[JOB:youtube-cleanup] backup-complete path=${backupPath} elapsedMs=${Date.now() - startedAt}`);
    console.info("[JOB:youtube-cleanup] delete-start");
    for (const { collection, ids } of scopes) {
      for (let start = 0; start < ids.length; start += 250) await collection.delete({ ids: ids.slice(start, start + 250) });
    }
    for (const key of objectKeys) {
      aws(["s3api", "delete-object", "--bucket", config.s3Bucket, "--key", key]);
      aws(["s3api", "wait", "object-not-exists", "--bucket", config.s3Bucket, "--key", key]);
    }
    for (const scope of scopes) {
      const remaining = await vectorScope(scope.collection);
      const retained = new Set(remaining.retainedIds);
      if (remaining.ids.length || scope.retainedIds.some((id) => !retained.has(id))) {
        throw new Error("Vector cleanup verification failed; use the backup to recover");
      }
    }
    await pool.query('DELETE FROM "KnowledgeDocument" WHERE id = ANY($1::text[])', [documents.rows.map((doc) => doc.id)]);
    await pool.query('DELETE FROM "KnowledgeSource" WHERE id = ANY($1::text[])', [sourceIds]);
    const remaining = await pool.query(`SELECT
      (SELECT count(*) FROM "KnowledgeDocument" WHERE starts_with(slug, $1)) +
      (SELECT count(*) FROM "KnowledgeSource" WHERE connector = $2) AS count`, [prefix, "youtube"]);
    if (Number(remaining.rows[0].count)) throw new Error("Database cleanup verification failed");
    await pool.query("COMMIT");
    transaction = false;
    console.info(`[JOB:youtube-cleanup] complete backup=${backupPath} elapsedMs=${Date.now() - startedAt}`);
  }
} catch (error) {
  if (transaction) await pool.query("ROLLBACK");
  console.error(`[JOB:youtube-cleanup] failed backup=${backupPath ?? "none"} elapsedMs=${Date.now() - startedAt} error=${error instanceof Error ? error.message : "UnknownError"}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

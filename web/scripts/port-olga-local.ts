import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { resolve } from "node:path";
import { parse } from "dotenv";
import { Client } from "pg";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { AdminClient, ChromaClient, ChromaNotFoundError, CloudClient, IncludeEnum } from "chromadb";

const ORG = "bc657406-6209-4bb8-af6f-c0d8141a17a4";
const DATABASE = `org_${ORG}`;
const ROOT = resolve(import.meta.dir, "../..");
const PRIVATE = resolve(ROOT, "backups/olga-local");
const CACHE = resolve(PRIVATE, "private-cache");
const BUCKET = "olga-local";
type Row = Record<string, unknown>;
type Snapshot = Record<string, Row[]>;
type ObjectRecord = { sha256: string; size: number; contentType?: string };
type EmbeddingRecord = { input: string; embedding: number[]; sourceIds: string[] };
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Row | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value) throw new Error("Required string missing");
  return value;
};
const tables = ["organization", "Voice", "Avatar", "Persona", "Agent", "SpecVersion",
  "KnowledgeBase", "KnowledgeSource", "KnowledgeDocument", "SkillSource", "PersonaSource"] as const;

export function assertTarget(host: string, database: string, endpoint: string) {
  if (host !== "/tmp" || database !== "trainertwin_olga_local" || endpoint !== "http://127.0.0.1:9100") {
    throw new Error("Refusing non-fixed local target");
  }
}

export function embeddingInput(context: unknown, document: string) {
  return typeof context === "string" && context ? `${context}\n${document}` : document;
}

export function vectorsMatch(source: number[], target: number[]) {
  return source.length === target.length && source.every((value, index) =>
    Number.isFinite(value) && Number.isFinite(target[index])
    && Math.abs(value - target[index]) <= Math.max(Math.abs(value), Math.abs(target[index])) * 3e-7);
}

async function privateJson(name: string, value: unknown) {
  const path = resolve(PRIVATE, name);
  await writeFile(`${path}.partial`, JSON.stringify(value), { mode: 0o600 });
  await chmod(`${path}.partial`, 0o600);
  await rename(`${path}.partial`, path);
}

async function sourceSelect(client: Client, sql: string, values: string[] = []) {
  if (!/^SELECT\b/i.test(sql) || sql.includes(";")) throw new Error("Source permits one SELECT only");
  return client.query(sql, values);
}

async function snapshot(client: Client): Promise<Snapshot> {
  const predicates: Record<string, string> = {
    organization: 'id = $1',
    Voice: `"id" IN (SELECT "voiceId" FROM "Persona" WHERE "orgId"=$1)`,
    Avatar: `"id" IN (SELECT "avatarId" FROM "Persona" WHERE "orgId"=$1)`,
    KnowledgeDocument: `"kbId" IN (SELECT id FROM "KnowledgeBase" WHERE "orgId"=$1)`,
  };
  const result: Snapshot = {};
  for (const table of tables) {
    const rows = await sourceSelect(client,
      `SELECT row_to_json(t) AS row FROM "${table}" t WHERE ${predicates[table] ?? '"orgId"=$1'} ORDER BY row_to_json(t)::text`, [ORG]);
    result[table] = rows.rows.map((row: { row: Row }) => row.row);
  }
  return result;
}

async function fileHash(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  if (!process.argv.includes("--apply")) throw new Error("Requires --apply; all targets are fixed local services");
  process.umask(0o077);
  assertTarget("/tmp", "trainertwin_olga_local", "http://127.0.0.1:9100");
  await mkdir(CACHE, { recursive: true, mode: 0o700 });
  await chmod(CACHE, 0o700);
  const env = parse(await readFile(resolve(ROOT, "../application/web/.env")));
  const source = new Client({ host: "/tmp", database: "trainertwin", options: "-c default_transaction_read_only=on" });
  const target = new Client({ host: "/tmp", database: "trainertwin_olga_local" });
  await source.connect();
  await target.connect();
  try {
    const identity = await sourceSelect(source, "SELECT current_database() AS db, current_setting('transaction_read_only') AS ro, inet_server_addr() AS addr");
    if (identity.rows[0].db !== "trainertwin" || identity.rows[0].ro !== "on" || identity.rows[0].addr !== null) throw new Error("Source identity/read-only guard failed");
    const targetIdentity = await target.query("SELECT current_database() AS db, inet_server_addr() AS addr");
    if (targetIdentity.rows[0].db !== "trainertwin_olga_local" || targetIdentity.rows[0].addr !== null) throw new Error("Target identity guard failed");
    const before = await snapshot(source);
    if (before.organization.length !== 1 || before.organization[0].slug !== "olga") throw new Error("Source organization guard failed");
    for (const [table, count] of Object.entries({ Agent: 12, Persona: 10, SpecVersion: 23, KnowledgeDocument: 139, SkillSource: 52, PersonaSource: 0 })) {
      if (before[table].length !== count) throw new Error(`Source inventory changed: ${table}`);
    }
    await privateJson("private-source-before.json", { identity: identity.rows[0], fingerprint: sha(JSON.stringify(before)), rows: before });
    const region = text(env.AWS_REGION || "ap-south-1").trim();
    if (!/^[a-z]{2}-[a-z]+-\d$/.test(region)) throw new Error("Invalid source region");
    const sourceS3 = new S3Client({
      region, endpoint: `https://s3.${region}.amazonaws.com`,
      credentials: { accessKeyId: text(env.AWS_ACCESS_KEY_ID), secretAccessKey: text(env.AWS_SECRET_ACCESS_KEY),
        ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) },
    });
    const sourceBucket = text(env.S3_BUCKET || env.AWS_S3_BUCKET).trim();
    const localS3 = new S3Client({ region: "us-east-1", endpoint: "http://127.0.0.1:9100", forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" } });
    const manifestPath = resolve(PRIVATE, "private-objects.json");
    const manifest: Record<string, ObjectRecord> = await Bun.file(manifestPath).exists()
      ? JSON.parse(await readFile(manifestPath, "utf8")) : {};
    const keys = new Map<string, boolean>();
    const authorize = (key: string) => {
      if (!key || key.split("/").includes("..") || key.startsWith("/") || key.includes("://")) throw new Error("Unsafe object key");
      return key;
    };
    const addOwned = (value: unknown, owner: string | null = ORG, optional = false) => {
      if (value === null || value === undefined) return;
      const key = authorize(text(value));
      const prefixes = [`prod/trainertwin/kb/${owner ?? "global"}/`, `trainertwin/kb/${owner ?? "global"}/`];
      if (!prefixes.some(prefix => key.startsWith(prefix))) throw new Error("Object ownership guard failed");
      keys.set(key, optional && (keys.get(key) ?? true));
    };
    for (const row of before.KnowledgeDocument) for (const field of ["s3SourceKey", "s3MarkdownKey", "s3QuestionsKey"]) addOwned(row[field]);
    for (const table of ["Voice", "Avatar"]) for (const row of before[table]) {
      if (row.orgId !== null && row.orgId !== ORG) throw new Error("Cross-org media");
      for (const [field, value] of Object.entries(row)) if (field.startsWith("s3") && field.endsWith("Key")) addOwned(value, row.orgId === null ? null : ORG);
    }
    const packages = new Map<string, { manifest: string; patterns: boolean }>();
    const projections = (value: unknown) => {
      if (Array.isArray(value)) { value.forEach(projections); return; }
      const row = object(value);
      if (!row) return;
      if (typeof row.artifacts === "string") {
        const prefix = authorize(row.artifacts);
        addOwned(`${prefix}/SKILL.md`);
        const scenario = object(row.scenario);
        const manifestName = scenario && ("roles" in scenario || "moves" in scenario || "roleplay" in scenario || "learner_role" in scenario) ? "scenario.json" : row.source === "roleplay-builder" ? "scenario.json" : "skill.json";
        packages.set(prefix, { manifest: manifestName, patterns: typeof row.patterns === "string" });
      }
      Object.values(row).forEach(projections);
    };
    before.Agent.forEach(row => projections(row.data));
    before.SpecVersion.forEach(row => projections(row.data));
    for (const [prefix, pkg] of packages) {
      addOwned(`${prefix}/${pkg.manifest}`);
      addOwned(`${prefix}/items.json`);
      addOwned(`${prefix}/patterns.md`, ORG, !pkg.patterns);
    }
    await privateJson("private-inventory.json", {
      packages: [...packages].map(([prefix, value]) => ({ prefix, ...value })),
      objects: [...keys].map(([key, optional]) => ({ key, optional, cacheFile: sha(key) })),
    });
    const missingOptional: string[] = [];
    async function copyObject(key: string, optional: boolean) {
      const path = resolve(CACHE, sha(key));
      const known = manifest[key];
      let cached = known && await Bun.file(path).exists() && (await stat(path)).size === known.size && await fileHash(path) === known.sha256;
      let contentType = known?.contentType;
      if (!cached) {
        let response;
        try {
          response = await sourceS3.send(new GetObjectCommand({ Bucket: sourceBucket, Key: key }));
        } catch (error) {
          if (optional && error instanceof Error && error.name === "NoSuchKey") { missingOptional.push(key); return; }
          await privateJson("private-object-failure.json", { key, error: error instanceof Error ? error.name : "unknown" });
          throw new Error(`Source object unavailable (${sha(key)}): ${error instanceof Error ? error.name : "unknown"}`);
        }
        if (!response.Body) throw new Error(`Empty source response: ${sha(key)}`);
        contentType = response.ContentType;
        const hash = createHash("sha256");
        let size = 0;
        const hashing = new Transform({ transform(chunk: Buffer, _encoding, callback) { size += chunk.length; hash.update(chunk); callback(null, chunk); } });
        await pipeline(response.Body.transformToWebStream(), hashing, createWriteStream(`${path}.partial`, { mode: 0o600 }));
        if (response.ContentLength !== undefined && size !== response.ContentLength) throw new Error("Incomplete object download");
        await rename(`${path}.partial`, path);
        manifest[key] = { sha256: hash.digest("hex"), size, contentType };
        await privateJson("private-objects.json", manifest);
        cached = true;
      }
      if (!cached) throw new Error("Object cache verification failed");
      await localS3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: createReadStream(path),
        ContentLength: manifest[key].size, ContentType: contentType }));
      const verification = await localS3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      if (!verification.Body) throw new Error("Local object verification body missing");
      const hash = createHash("sha256");
      for await (const chunk of verification.Body.transformToWebStream()) hash.update(chunk);
      if (hash.digest("hex") !== manifest[key].sha256) throw new Error("Local object checksum mismatch");
      await privateJson("private-objects.json", manifest);
    }
    let completed = 0;
    for (const [key, optional] of keys) {
      await copyObject(key, optional);
      if (++completed % 25 === 0) console.log(JSON.stringify({ objectsProcessed: completed, objectTotal: keys.size }));
    }

    const org = before.organization[0];
    const cloud = new CloudClient({ apiKey: text(env.CHROMA_API_KEY), tenant: text(org.chromaTenantId), database: text(org.chromaDatabase) });
    const collection = await cloud.getCollection({ name: "main", embeddingFunction: null });
    const sourceCount = await collection.count();
    const admin = new AdminClient({ host: "127.0.0.1", port: 8101, ssl: false });
    try { await admin.getDatabase({ name: DATABASE, tenant: "default_tenant" }); }
    catch (error) {
      if (!(error instanceof ChromaNotFoundError)) throw error;
      await admin.createDatabase({ name: DATABASE, tenant: "default_tenant" });
    }
    const local = new ChromaClient({ host: "127.0.0.1", port: 8101, ssl: false, tenant: "default_tenant", database: DATABASE });
    let localCollection;
    try { localCollection = await local.getCollection({ name: "main", embeddingFunction: null }); }
    catch (error) {
      if (!(error instanceof ChromaNotFoundError)) throw error;
      const space = collection.configuration.hnsw?.space ?? collection.configuration.spann?.space ?? collection.metadata?.["hnsw:space"];
      if (space !== "cosine") throw new Error("Source main does not have verified cosine distance");
      localCollection = await local.createCollection({ name: "main", embeddingFunction: null, metadata: collection.metadata, configuration: { hnsw: { space: "cosine" } } });
    }
    const embeddings: Record<string, EmbeddingRecord> = {};
    const vectorHash = createHash("sha256");
    let vectorCount = 0;
    for (let offset = 0; offset < sourceCount; offset += 300) {
      const page = await collection.get({ limit: 300, offset, include: [IncludeEnum.documents, IncludeEnum.metadatas, IncludeEnum.embeddings] });
      if (!page.ids.length) throw new Error("Source vector page unexpectedly empty");
      const vectors = page.ids.map((id, index) => {
        const embedding = page.embeddings?.[index];
        const metadata = page.metadatas[index];
        const document = page.documents[index];
        if (!embedding?.length || !metadata || document === null) throw new Error("Incomplete source vector record");
        if (!["knowledge", "persona_voice", "persona_voice_episode", "persona_style_episode", "scenario_item"].includes(String(metadata.type))) throw new Error("Unexpected non-content vector type");
        if (metadata.orgId !== undefined && metadata.orgId !== ORG) throw new Error("Cross-org vector record");
        if (metadata.type === "scenario_item") {
          const input = embeddingInput(metadata.context, document);
          const key = sha(input);
          if (embeddings[key] && JSON.stringify(embeddings[key].embedding) !== JSON.stringify(embedding)) throw new Error("Conflicting vectors for identical embedding input");
          embeddings[key] ??= { input, embedding, sourceIds: [] };
          embeddings[key].sourceIds.push(id);
        }
        return { id, embedding, metadata, document };
      });
      await privateJson(`private-vectors-${offset}.json`, vectors);
      await localCollection.upsert({ ids: page.ids, embeddings: vectors.map(row => row.embedding),
        metadatas: vectors.map(row => row.metadata), documents: vectors.map(row => row.document) });
      const verified = await localCollection.get({ ids: page.ids, include: [IncludeEnum.documents, IncludeEnum.metadatas, IncludeEnum.embeddings] });
      const byId = new Map(verified.ids.map((id, index) => [id, index]));
      for (const row of vectors) {
        const index = byId.get(row.id);
        if (index === undefined || !verified.embeddings?.[index] || !vectorsMatch(row.embedding, verified.embeddings[index])
          || verified.documents[index] !== row.document || stable(verified.metadatas[index]) !== stable(row.metadata)) throw new Error("Local vector verification failed");
      }
      vectorHash.update(JSON.stringify(vectors));
      vectorCount += vectors.length;
      console.log(JSON.stringify({ vectorsCopied: vectorCount, vectorTotal: sourceCount }));
    }
    if (await collection.count() !== sourceCount || await localCollection.count() !== sourceCount) throw new Error("Vector count changed or differs");
    await privateJson("private-embedding-cache.json", { algorithm: "sha256", renderer: "context ? context + '\\n' + text : text", records: embeddings });
    const coverage: Row[] = [];
    for (const prefix of packages.keys()) {
      const items: unknown = JSON.parse(await readFile(resolve(CACHE, sha(`${prefix}/items.json`)), "utf8"));
      if (!Array.isArray(items)) throw new Error("Package items is not an array");
      const missing: number[] = [];
      items.forEach((value: unknown, index: number) => {
        const item = object(value);
        if (!item || typeof item.text !== "string") throw new Error("Invalid package item");
        if (!embeddings[sha(embeddingInput(item.context, item.text))]) missing.push(index);
      });
      coverage.push({ prefix, items: items.length, cached: items.length - missing.length, missing });
    }
    await privateJson("private-embedding-coverage.json", coverage);

    await target.query("BEGIN");
    try {
      for (const table of tables) {
        for (const original of before[table]) {
          const row = { ...original };
          if (table === "organization") {
            row.chromaTenantId = "default_tenant"; row.chromaDatabase = DATABASE;
            row.metadata = null;
          }
          if (table === "KnowledgeSource") { row.status = "unavailable"; row.error = "Local content copy: synchronization disabled"; }
          const columns = Object.keys(row);
          if (columns.some(column => !/^[A-Za-z][A-Za-z0-9]*$/.test(column))) throw new Error("Invalid column");
          const list = columns.map(column => `"${column}"`).join(",");
          await target.query(`INSERT INTO "${table}" (${list}) SELECT ${list} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb) ON CONFLICT DO NOTHING`, [JSON.stringify(row)]);
          const match = await target.query(`SELECT count(*)::int AS count FROM "${table}" t WHERE to_jsonb(t) = $1::jsonb`, [JSON.stringify(row)]);
          if (match.rows[0].count !== 1) throw new Error(`Target conflict or mismatch: ${table}`);
        }
      }
      await target.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('olga-local-admin','Local admin','olga-local-admin@localhost.invalid',true,now(),now()) ON CONFLICT (id) DO NOTHING`);
      await target.query(`INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ('olga-local-admin-member',$1,'olga-local-admin','admin',now()) ON CONFLICT (id) DO NOTHING`, [ORG]);
      await target.query("COMMIT");
    } catch (error) { await target.query("ROLLBACK"); throw error; }
    const after = await snapshot(source);
    const sourceFingerprint = sha(JSON.stringify(before));
    const afterFingerprint = sha(JSON.stringify(after));
    await privateJson("private-source-after.json", { fingerprint: afterFingerprint, rows: after });
    if (sourceFingerprint !== afterFingerprint) throw new Error("Source content changed during copy; inspect private audit");
    const report = {
      organizationId: ORG, targetDatabase: "trainertwin_olga_local", localBucket: BUCKET, localChromaDatabase: DATABASE,
      counts: Object.fromEntries(Object.entries(before).map(([table, rows]) => [table, rows.length])),
      objectCount: Object.keys(manifest).length, bytes: Object.values(manifest).reduce((sum, value) => sum + value.size, 0),
      optionalAbsent: missingOptional.length, packages: packages.size, vectors: vectorCount, vectorFingerprint: vectorHash.digest("hex"),
      embeddingInputs: Object.keys(embeddings).length,
      packageItems: coverage.reduce((sum, row) => sum + Number(row.items), 0),
      packageItemsCached: coverage.reduce((sum, row) => sum + Number(row.cached), 0),
      sourceBeforeFingerprint: sourceFingerprint, sourceAfterFingerprint: afterFingerprint,
    };
    await privateJson("private-report.json", report);
    console.log(JSON.stringify(report));
  } finally { await source.end(); await target.end(); }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(stable));
  const row = object(value);
  return row ? JSON.stringify(Object.keys(row).sort().map(key => [key, stable(row[key])])) : JSON.stringify(value);
}

if (import.meta.main) await main();

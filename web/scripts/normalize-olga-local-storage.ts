import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Client } from "pg";
import { z } from "zod";
import { assertRestoreEnvironment } from "./restore-olga-local-skills";

const ORG = "bc657406-6209-4bb8-af6f-c0d8141a17a4";
const OLD = `trainertwin/kb/${ORG}/`;
const NEW = `prod/${OLD}`;
const PRIVATE = resolve(import.meta.dir, "../../backups/olga-local");
const BUCKET = "olga-local";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
type Row = Record<string, unknown>;

export function aliasKey(key: string): string | undefined {
  if (!key.startsWith(OLD)) return undefined;
  if (key.split("/").includes("..")) throw new Error("Unsafe storage path");
  return `prod/${key}`;
}

export function assertAliasChecksum(expected: string, actual: string) {
  if (expected !== actual) throw new Error("Local alias collision or checksum mismatch");
}

export function normalizeStorage(value: unknown, verified: ReadonlySet<string>): unknown {
  if (typeof value === "string") {
    const alias = aliasKey(value);
    if (!alias) return value;
    if (!verified.has(value)) throw new Error("Unverified local storage reference");
    return alias;
  }
  if (Array.isArray(value)) return value.map(item => normalizeStorage(item, verified));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeStorage(item, verified)]));
  }
  return value;
}

async function fileHash(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function privateReport(value: unknown) {
  const path = resolve(PRIVATE, "private-normalization-report.json");
  await writeFile(`${path}.partial`, JSON.stringify(value), { mode: 0o600 });
  await chmod(`${path}.partial`, 0o600);
  await rename(`${path}.partial`, path);
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--apply") throw new Error("Requires --apply after a fresh local copy, before registry restore");
  assertRestoreEnvironment(process.env);
  process.umask(0o077);
  const manifest = z.record(z.string(), z.object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative(), contentType: z.string().optional(),
  })).parse(JSON.parse(await readFile(resolve(PRIVATE, "private-objects.json"), "utf8")));
  const sourceAudits = ["private-source-before.json", "private-source-after.json", "private-objects.json", "private-inventory.json"];
  const auditHashes = Object.fromEntries(await Promise.all(sourceAudits.map(async name => [name, await fileHash(resolve(PRIVATE, name))])));
  const client = new Client({ host: "/tmp", port: 5432, database: "trainertwin_olga_local" });
  await client.connect();
  try {
    const identity = await client.query("SELECT current_database() AS db, inet_server_addr() AS addr");
    if (identity.rows[0].db !== "trainertwin_olga_local" || identity.rows[0].addr !== null) throw new Error("Fixed local database identity guard failed");
    const org = await client.query('SELECT slug,"chromaTenantId","chromaDatabase" FROM organization WHERE id=$1', [ORG]);
    if (org.rowCount !== 1 || org.rows[0].slug !== "olga" || org.rows[0].chromaTenantId !== "default_tenant"
      || org.rows[0].chromaDatabase !== `org_${ORG}`) throw new Error("Local organization guard failed");
    const registry = await client.query('SELECT count(*)::int AS count FROM "Skill" WHERE "orgId"=$1', [ORG]);
    if (registry.rows[0].count !== 0) throw new Error("Normalize only before registry restoration; do not rewrite active registry storage");
    const s3 = new S3Client({
      endpoint: "http://127.0.0.1:9100", region: "us-east-1", forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED", credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" },
    });
    async function objectHash(key: string, optional: boolean): Promise<string | undefined> {
      let response;
      try { response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key })); }
      catch (error) {
        if (optional && error instanceof Error && error.name === "NoSuchKey") return undefined;
        throw error;
      }
      if (!response.Body) throw new Error("Local object response body missing");
      const hash = createHash("sha256");
      for await (const chunk of response.Body.transformToWebStream()) hash.update(chunk);
      return hash.digest("hex");
    }
    const aliases: { original: string; alias: string; sha256: string; size: number; existed: boolean }[] = [];
    const verified = new Set<string>();
    const otherPrefixes = new Map<string, number>();
    const report = () => ({
      organizationId: ORG, targetDatabase: "trainertwin_olga_local", bucket: BUCKET,
      phase: "aliases", aliases, otherPrefixes: Object.fromEntries(otherPrefixes), sourceAuditHashes: auditHashes,
      rerunPolicy: "Run after a fresh copy and before registry restore. Original copy reruns intentionally refuse normalized DB rows.",
    });
    for (const [key, record] of Object.entries(manifest)) {
      const alias = aliasKey(key);
      if (!alias) {
        if (!key.startsWith(NEW)) throw new Error("Unexpected copied storage prefix; inspect privately before normalization");
        otherPrefixes.set("already-normalized-own-org", (otherPrefixes.get("already-normalized-own-org") ?? 0) + 1);
        continue;
      }
      if (manifest[alias]) assertAliasChecksum(record.sha256, manifest[alias].sha256);
      const path = resolve(PRIVATE, "private-cache", sha(key));
      if ((await stat(path)).size !== record.size || await fileHash(path) !== record.sha256) throw new Error("Original private cache failed verification");
      assertAliasChecksum(record.sha256, (await objectHash(key, false)) ?? "");
      const existing = await objectHash(alias, true);
      if (existing !== undefined) assertAliasChecksum(record.sha256, existing);
      else {
        await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: alias, Body: createReadStream(path),
          ContentLength: record.size, ContentType: record.contentType }));
        assertAliasChecksum(record.sha256, (await objectHash(alias, false)) ?? "");
      }
      aliases.push({ original: key, alias, sha256: record.sha256, size: record.size, existed: existing !== undefined });
      let reference = key;
      while (reference.length >= OLD.length) {
        verified.add(reference);
        const parent = reference.lastIndexOf("/");
        if (parent < OLD.length - 1) break;
        reference = reference.slice(0, parent);
      }
      await privateReport(report());
      if (aliases.length % 50 === 0) console.log(JSON.stringify({ aliasesVerified: aliases.length }));
    }
    const configs: { table: string; predicate: string; columns: string[] }[] = [
      { table: "Agent", predicate: '"orgId"=$1', columns: ["data"] },
      { table: "Persona", predicate: '"orgId"=$1', columns: ["data"] },
      { table: "SpecVersion", predicate: '"orgId"=$1', columns: ["data"] },
      { table: "KnowledgeDocument", predicate: '"kbId" IN (SELECT id FROM "KnowledgeBase" WHERE "orgId"=$1)', columns: ["s3SourceKey", "s3MarkdownKey", "s3QuestionsKey"] },
      { table: "Voice", predicate: '"orgId"=$1', columns: ["s3AudioKey", "s3TranscriptKey"] },
      { table: "Avatar", predicate: '"orgId"=$1', columns: ["s3ImageKey", "s3OriginalImageKey", "s3VideoKey"] },
    ];
    const changes: { table: string; id: string; columns: string[]; before: Row; after: Row }[] = [];
    await client.query("BEGIN");
    try {
      for (const config of configs) {
        const selected = await client.query(`SELECT row_to_json(t) AS row FROM "${config.table}" t WHERE ${config.predicate} FOR UPDATE`, [ORG]);
        for (const selectedRow of selected.rows) {
          const before: Row = selectedRow.row;
          const after = { ...before };
          const columns: string[] = [];
          for (const column of config.columns) {
            after[column] = normalizeStorage(before[column], verified);
            if (JSON.stringify(after[column]) !== JSON.stringify(before[column])) columns.push(column);
          }
          if (!columns.length) continue;
          if (typeof before.id !== "string") throw new Error("Invalid authored row identity");
          const assignments = columns.map(column => `"${column}"=incoming."${column}"`).join(",");
          const updated = await client.query(`UPDATE "${config.table}" t SET ${assignments} FROM jsonb_populate_record(NULL::"${config.table}",$1::jsonb) incoming WHERE t.id=$2 AND to_jsonb(t)=$3::jsonb RETURNING t.id,to_jsonb(t)=$1::jsonb AS matches`,
            [JSON.stringify(after), before.id, JSON.stringify(before)]);
          if (updated.rowCount !== 1 || !updated.rows[0].matches) throw new Error("Local authored row changed concurrently or failed verification");
          changes.push({ table: config.table, id: before.id, columns, before, after });
        }
      }
      for (const name of sourceAudits) if (await fileHash(resolve(PRIVATE, name)) !== auditHashes[name]) throw new Error("Original private source export changed");
      await privateReport({ ...report(), phase: "prepared", changes });
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    const counts = Object.fromEntries(configs.map(config => [config.table, changes.filter(change => change.table === config.table).length]));
    await privateReport({ ...report(), phase: "complete", changes, rowsChanged: counts });
    console.log(JSON.stringify({ aliasesVerified: aliases.length, rowsChanged: counts, sourceExportsUnchanged: true }));
  } finally { await client.end(); }
}

if (import.meta.main) await main();

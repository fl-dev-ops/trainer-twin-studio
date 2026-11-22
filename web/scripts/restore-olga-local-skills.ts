import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { SkillMigrationEntry } from "../lib/skill-migration";

const ORG = "bc657406-6209-4bb8-af6f-c0d8141a17a4";
const DATABASE = "trainertwin_olga_local";
const PRIVATE = resolve(import.meta.dir, "../../backups/olga-local");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

export function assertRestoreEnvironment(env: NodeJS.ProcessEnv) {
  const url = new URL(env.DATABASE_URL ?? "");
  if (url.protocol !== "postgresql:" || url.hostname !== "localhost" || url.port !== "5432"
    || url.pathname !== `/${DATABASE}` || url.searchParams.get("host") !== "/tmp"
    || [...url.searchParams.keys()].length !== 1
    || (env.DATABASE_URL_UNPOOLED && env.DATABASE_URL_UNPOOLED !== env.DATABASE_URL)) {
    throw new Error("Restore requires the fixed local database over the /tmp Unix socket");
  }
  if (env.AWS_ENDPOINT_URL_S3 !== "http://127.0.0.1:9100"
    || (env.AWS_ENDPOINT_URL && env.AWS_ENDPOINT_URL !== env.AWS_ENDPOINT_URL_S3)
    || env.S3_BUCKET !== "olga-local" || (env.AWS_S3_BUCKET && env.AWS_S3_BUCKET !== "olga-local")
    || env.AWS_ACCESS_KEY_ID !== "S3RVER" || env.AWS_SECRET_ACCESS_KEY !== "S3RVER"
    || env.AWS_SESSION_TOKEN || env.S3_BASE_PREFIX !== "prod/trainertwin/kb") {
    throw new Error("Restore requires fixed local S3 with fake credentials");
  }
  if (env.CHROMA_URL !== "http://127.0.0.1:8101" || env.CHROMA_TENANT !== "default_tenant" || env.CHROMA_API_KEY) {
    throw new Error("Restore requires fixed local Chroma without cloud credentials");
  }
}

export function cachedEmbeddingResolver(value: unknown) {
  const cache = z.object({
    algorithm: z.literal("sha256"),
    renderer: z.literal("context ? context + '\\n' + text : text"),
    records: z.record(z.string(), z.object({
      input: z.string(), embedding: z.array(z.number().finite()).min(1), sourceIds: z.array(z.string()).min(1),
    })),
  }).parse(value);
  let dimension: number | undefined;
  for (const [key, record] of Object.entries(cache.records)) {
    if (sha(record.input) !== key) throw new Error("Embedding cache input checksum mismatch");
    dimension ??= record.embedding.length;
    if (record.embedding.length !== dimension) throw new Error("Embedding cache dimensions disagree");
  }
  return (items: { context: string; text: string }[]) => items.map((item) => {
    const input = item.context ? `${item.context}\n${item.text}` : item.text;
    const key = sha(input);
    const record = cache.records[key];
    if (!record || record.input !== input) throw new Error(`Missing exact imported embedding: ${key}`);
    return record.embedding;
  });
}

export function assertRestoreEntries(
  entries: SkillMigrationEntry[],
  phase: "preflight" | "apply" | "check",
  historicalUnavailable: SkillMigrationEntry[] = [],
) {
  if (!entries.length) throw new Error("Restore has no package entries");
  const unavailable: SkillMigrationEntry[] = [];
  for (const entry of entries) {
    if (phase === "preflight" ? entry.status === "verified" || entry.status === "unmapped"
      : entry.status === (phase === "apply" ? "imported" : "verified")) continue;
    const missingOriginal = phase !== "check" && entry.status === "failed"
      && /^Error: Missing exact imported embedding: [a-f0-9]{64}$/.test(entry.error ?? "");
    const knownUnavailable = phase === "check" && entry.status === "unmapped"
      && historicalUnavailable.some((known) => known.slug === entry.slug && known.agentVersion === entry.agentVersion
        && known.contentHash === entry.contentHash);
    if (!entry.current && !entry.required && (missingOriginal || knownUnavailable)) {
      unavailable.push(entry);
      continue;
    }
    throw new Error(`Restore ${phase} refused ${entry.slug}@${entry.agentVersion}: ${entry.error ?? entry.status}`);
  }
  return unavailable;
}

async function privateReport(value: unknown) {
  await mkdir(PRIVATE, { recursive: true, mode: 0o700 });
  await chmod(PRIVATE, 0o700);
  const path = resolve(PRIVATE, "private-skill-restore-report.json");
  await writeFile(`${path}.partial`, JSON.stringify(value), { mode: 0o600 });
  await chmod(`${path}.partial`, 0o600);
  await rename(`${path}.partial`, path);
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--apply") throw new Error("Requires --apply after the local copy has completed");
  assertRestoreEnvironment(process.env);
  process.umask(0o077);
  const copied = z.object({
    organizationId: z.literal(ORG), targetDatabase: z.literal(DATABASE), localBucket: z.literal("olga-local"),
    localChromaDatabase: z.literal(`org_${ORG}`),
    sourceBeforeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    sourceAfterFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }).parse(JSON.parse(await readFile(resolve(PRIVATE, "private-report.json"), "utf8")));
  if (copied.sourceBeforeFingerprint !== copied.sourceAfterFingerprint) throw new Error("Copy source audit fingerprints disagree");
  const importedEmbeddings = cachedEmbeddingResolver(JSON.parse(await readFile(resolve(PRIVATE, "private-embedding-cache.json"), "utf8")));
  const { db } = await import("../lib/db");
  try {
    const identity = await db.$queryRaw<{ database: string; address: string | null }[]>`
      SELECT current_database() AS database, inet_server_addr()::text AS address`;
    if (identity.length !== 1 || identity[0].database !== DATABASE || identity[0].address !== null) {
      throw new Error("Connected database identity or Unix socket guard failed");
    }
    const org = await db.organization.findUniqueOrThrow({ where: { id: ORG } });
    if (org.slug !== "olga" || org.chromaTenantId !== "default_tenant" || org.chromaDatabase !== `org_${ORG}`) {
      throw new Error("Local Olga organization or vector destination guard failed");
    }
    const { presignedGetUrl } = await import("../lib/s3");
    const probe = new URL(await presignedGetUrl(`prod/trainertwin/kb/${ORG}/restore-endpoint-check`));
    if (probe.origin !== "http://127.0.0.1:9100" || !probe.pathname.startsWith("/olga-local/")) {
      throw new Error("Effective S3 endpoint is not the fixed local bucket");
    }
    const { migrateSkills, checkSkillMigrationCoverage } = await import("../lib/skill-migration");
    const preflight = [];
    let after: string | undefined;
    do {
      const page = await migrateSkills(ORG, { batchSize: 500, after, importedEmbeddings });
      preflight.push(page);
      after = page.next ?? undefined;
    } while (after);
    await privateReport({ phase: "preflight", preflight });
    const historicalUnavailable = assertRestoreEntries(preflight.flatMap((page) => page.entries), "preflight");
    await privateReport({ phase: "preflight", preflight, historicalUnavailable });
    const applied = [];
    after = undefined;
    do {
      const page = await migrateSkills(ORG, { apply: true, batchSize: 500, after, importedEmbeddings });
      applied.push(page);
      await privateReport({ phase: "apply", preflight, applied, historicalUnavailable });
      assertRestoreEntries(page.entries, "apply");
      after = page.next ?? undefined;
    } while (after);
    const checked = await checkSkillMigrationCoverage(ORG, { batchSize: 500 });
    const appliedUnavailable = assertRestoreEntries(applied.flatMap((page) => page.entries), "apply");
    await privateReport({ phase: "check", preflight, applied, checked, historicalUnavailable: appliedUnavailable });
    assertRestoreEntries(checked.entries, "check", appliedUnavailable);
    if (checked.currentGaps.length || checked.requiredGaps.length) throw new Error("Restored current or required package coverage is incomplete");
    console.log(JSON.stringify({
      organizationId: ORG,
      verifiedVersions: checked.entries.filter((entry) => entry.status === "verified").length,
      verifiedCurrent: checked.entries.filter((entry) => entry.current && entry.status === "verified").length,
      historicalUnavailable: appliedUnavailable.map(({ slug, agentVersion, contentHash, error }) => ({ slug, agentVersion, contentHash, reason: error })),
      historicalUnavailableCount: appliedUnavailable.length,
      hash: checked.hash,
    }));
  } finally {
    await db.$disconnect();
  }
}

if (import.meta.main) await main();

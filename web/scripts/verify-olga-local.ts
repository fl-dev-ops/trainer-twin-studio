import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ChromaClient, type Where } from "chromadb";
import { z } from "zod";
import { assertRestoreEntries, assertRestoreEnvironment, cachedEmbeddingResolver } from "./restore-olga-local-skills";

const ORG = "bc657406-6209-4bb8-af6f-c0d8141a17a4";
const PRIVATE = resolve(import.meta.dir, "../../backups/olga-local");
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const record = z.record(z.string(), z.unknown());
const itemsSchema = z.array(z.object({ context: z.string(), text: z.string() }));
const entrySchema = z.object({
  slug: z.string(), agentVersion: z.number().int(), current: z.boolean(), required: z.boolean(),
  status: z.enum(["verified", "imported", "unmapped", "failed"]), contentHash: z.string().optional(), error: z.string().optional(),
});

export function sourceTimestamp(value: unknown) {
  const timestamp = typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? `${value}Z` : value;
  return z.coerce.date().parse(timestamp).toISOString();
}

export function assertVerificationCounts(counts: {
  agents: number; roleplays: number; twins: number; skillSources: number; specVersions: number;
  mappedVersions: number; currentTwinItems: number[]; historicalVersions: number[];
}) {
  if (counts.agents !== 12 || counts.roleplays !== 9 || counts.twins !== 3
    || counts.skillSources !== 52 || counts.specVersions !== 23 || counts.mappedVersions !== 16
    || JSON.stringify([...counts.currentTwinItems].sort((a, b) => a - b)) !== "[70,77]"
    || JSON.stringify([...counts.historicalVersions].sort((a, b) => a - b)) !== "[1,2,3,4]") {
    throw new Error("Local Olga inventory or explicit historical availability differs from the expected copy");
  }
}

async function saveReport(value: unknown) {
  await mkdir(PRIVATE, { recursive: true, mode: 0o700 });
  await chmod(PRIVATE, 0o700);
  const path = resolve(PRIVATE, "private-verification-report.json");
  await writeFile(`${path}.partial`, JSON.stringify(value), { mode: 0o600 });
  await chmod(`${path}.partial`, 0o600);
  await rename(`${path}.partial`, path);
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--verify") throw new Error("Requires --verify after local restore is confirmed complete");
  assertRestoreEnvironment(process.env);
  process.umask(0o077);
  const restore = z.object({
    phase: z.literal("check"), historicalUnavailable: z.array(entrySchema),
  }).parse(JSON.parse(await readFile(resolve(PRIVATE, "private-skill-restore-report.json"), "utf8")));
  const baseline = z.object({ rows: z.object({ SkillSource: z.array(record) }) })
    .parse(JSON.parse(await readFile(resolve(PRIVATE, "private-source-before.json"), "utf8")));
  const inventory = z.object({ packages: z.array(z.object({ prefix: z.string(), manifest: z.string() })) })
    .parse(JSON.parse(await readFile(resolve(PRIVATE, "private-inventory.json"), "utf8")));
  const originalObjects = z.record(z.string(), z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }))
    .parse(JSON.parse(await readFile(resolve(PRIVATE, "private-objects.json"), "utf8")));
  const embeddings = cachedEmbeddingResolver(JSON.parse(await readFile(resolve(PRIVATE, "private-embedding-cache.json"), "utf8")));
  const { db } = await import("../lib/db");
  try {
    const identity = await db.$queryRaw<{ database: string; address: string | null }[]>`
      SELECT current_database() AS database, inet_server_addr()::text AS address`;
    if (identity.length !== 1 || identity[0].database !== "trainertwin_olga_local" || identity[0].address !== null) throw new Error("Connected local database guard failed");
    const org = await db.organization.findUniqueOrThrow({ where: { id: ORG } });
    if (org.slug !== "olga" || org.chromaTenantId !== "default_tenant" || org.chromaDatabase !== `org_${ORG}`) throw new Error("Local Olga organization/vector identity differs");
    const member = await db.member.findFirst({ where: { organizationId: ORG, userId: "olga-local-admin", role: "admin" }, include: { user: true } });
    if (!member || member.user.email !== "olga-local-admin@localhost.invalid" || !member.user.emailVerified) throw new Error("Synthetic local admin identity differs");
    const { getObjectBytes, getObjectText, presignedGetUrl } = await import("../lib/s3");
    const probe = new URL(await presignedGetUrl(`prod/trainertwin/kb/${ORG}/verification-endpoint-check`));
    if (probe.origin !== "http://127.0.0.1:9100" || !probe.pathname.startsWith("/olga-local/")) throw new Error("Effective S3 endpoint is not local");
    const { stableJson } = await import("../lib/stable-json");
    const sources = await db.skillSource.findMany({ where: { orgId: ORG } });
    const canonicalRows = (rows: unknown[]) => rows.map((row) => {
      const value = record.parse(row);
      return stableJson({ ...value, createdAt: sourceTimestamp(value.createdAt) });
    }).sort();
    if (stableJson(canonicalRows(sources)) !== stableJson(canonicalRows(baseline.rows.SkillSource))) throw new Error("Original SkillSource rows were changed");
    const agents = await db.agent.findMany({ where: { orgId: ORG }, include: { persona: true } });
    const mainTwins = agents.filter((agent) => agent.kind === "TWIN" && record.parse(agent.data).source === "twin");
    if (mainTwins.length !== 1 || mainTwins[0].primarySkillId) throw new Error("Main twin must have no package of its own");
    const mainTwin = mainTwins[0];
    if (await db.skill.count({ where: { orgId: ORG, ownerSlug: mainTwin.slug } })) throw new Error("Main twin unexpectedly owns a registry package");
    const { checkSkillMigrationCoverage } = await import("../lib/skill-migration");
    const coverage = await checkSkillMigrationCoverage(ORG);
    const unavailable = assertRestoreEntries(coverage.entries, "check", restore.historicalUnavailable);
    if (coverage.currentGaps.length || coverage.requiredGaps.length) throw new Error("Current or required package coverage has gaps");
    const versions = await db.skillVersion.findMany({ where: { skill: { orgId: ORG } }, include: { skill: true, sources: true } });
    if (versions.some((version) => version.status !== "ready" || version.indexStatus !== "ready")) throw new Error("Registry contains an incomplete package");
    const { resolveSnapshotSkill } = await import("../lib/session-skills");
    const { resolveTwinCatalog } = await import("../lib/twins");
    const { getAgentConfigForAgent } = await import("../lib/specs");
    const current = [];
    for (const agent of agents) {
      if (agent.archivedAt) throw new Error("Expected local agent is archived");
      const resolved = await db.$transaction(async (tx) => {
        const config = await getAgentConfigForAgent(agent.id, ORG, undefined, [], tx);
        if (!config || config.agent.id !== agent.id || config.agent.version !== agent.version) throw new Error("Native agent config identity differs");
        if (agent.id === mainTwin.id) {
          const selected = await resolveTwinCatalog(ORG, agent.personaId, tx);
          return { agentId: agent.id, slug: agent.slug, kind: agent.kind, catalog: selected.catalog, pins: selected.pins };
        }
        const version = await resolveSnapshotSkill(ORG, agent, agent.kind, tx);
        const owner = versions.find((entry) => entry.id === version.id)?.skill;
        const mapping = await tx.agentSkillVersion.findUniqueOrThrow({ where: { agentId_agentVersion: { agentId: agent.id, agentVersion: agent.version } } });
        if (owner?.currentVersionId !== version.id || mapping.skillVersionId !== version.id || agent.primarySkillId !== version.skillId
          || (agent.kind === "ROLEPLAY" && version.format !== "builder-roleplay")
          || record.parse(config.agent.data).artifacts !== version.artifacts) throw new Error("Native current package/pinning identity differs");
        return { agentId: agent.id, slug: agent.slug, kind: agent.kind, versionId: version.id, itemCount: version.itemCount };
      });
      current.push(resolved);
    }
    const twinPackages = current.filter((entry) => entry.kind === "TWIN" && entry.versionId);
    const catalog = current.find((entry) => entry.agentId === mainTwin.id);
    if (!catalog?.catalog || !catalog.pins || catalog.catalog.length !== 2 || catalog.pins.length !== 2
      || stableJson(catalog.catalog.map((entry) => entry.skillVersionId).sort()) !== stableJson(twinPackages.map((entry) => entry.versionId).sort())
      || catalog.catalog.some((entry, position) => {
        const agent = agents.find((candidate) => candidate.slug === entry.slug);
        return !agent || agent.personaId !== mainTwin.personaId || entry.version !== agent.version
          || catalog.pins?.[position].skillVersionId !== entry.skillVersionId || catalog.pins[position].alias !== entry.slug || catalog.pins[position].position !== position;
      })) throw new Error("Main runtime catalog does not pin the two exact current skill twins");
    const counts = {
      agents: agents.length, roleplays: agents.filter((agent) => agent.kind === "ROLEPLAY").length,
      twins: agents.filter((agent) => agent.kind === "TWIN").length, skillSources: sources.length,
      specVersions: await db.specVersion.count({ where: { orgId: ORG } }),
      mappedVersions: await db.agentSkillVersion.count({ where: { orgId: ORG } }),
      currentTwinItems: twinPackages.map((entry) => entry.itemCount ?? -1),
      historicalVersions: unavailable.map((entry) => entry.agentVersion),
    };
    assertVerificationCounts(counts);
    const objection = twinPackages.find((entry) => entry.itemCount === 70);
    if (unavailable.some((entry) => entry.slug !== objection?.slug)) throw new Error("Unexpected unavailable historical owner");
    let originalFiles = 0;
    const missingInputs = new Set<string>();
    for (const pkg of inventory.packages) {
      if (![ `prod/trainertwin/kb/${ORG}/`, `trainertwin/kb/${ORG}/` ].some((prefix) => pkg.prefix.startsWith(prefix))
        || pkg.prefix.split("/").includes("..") || !["skill.json", "scenario.json"].includes(pkg.manifest)) throw new Error("Unsafe original package reference");
      for (const name of ["SKILL.md", pkg.manifest, "items.json", "patterns.md"]) {
        const key = `${pkg.prefix}/${name}`;
        const original = originalObjects[key];
        if (!original && name === "patterns.md") continue;
        if (!original || sha(await getObjectBytes(key)) !== original.sha256) throw new Error("Original local package checksum differs from the private copy audit");
        originalFiles++;
      }
      const items = itemsSchema.parse(JSON.parse(await getObjectText(`${pkg.prefix}/items.json`)));
      for (const item of items) {
        try { embeddings([item]); }
        catch (error) {
          if (!(error instanceof Error) || !/^Missing exact imported embedding: [a-f0-9]{64}$/.test(error.message)) throw error;
          missingInputs.add(sha(item.context ? `${item.context}\n${item.text}` : item.text));
        }
      }
    }
    if (missingInputs.size !== 8) throw new Error("Original missing-vector inventory differs from the eight explicitly unavailable inputs");
    const { verifySkillEnvelope } = await import("../lib/skills");
    const { MainCollectionService, skillScopeWhere, scenarioScopeWhere } = await import("../lib/main-collection");
    const collection = await new ChromaClient({ host: "127.0.0.1", port: 8101, ssl: false, tenant: "default_tenant", database: `org_${ORG}` })
      .getCollection({ name: "main", embeddingFunction: null });
    const retrieval = [];
    for (const version of versions) {
      const files = verifySkillEnvelope(version);
      for (const [name, bytes] of Object.entries(files)) {
        if (await getObjectText(`${version.artifacts}/${name}`) !== bytes) throw new Error("Registered local package bytes differ from its immutable envelope");
      }
      const items = itemsSchema.parse(JSON.parse(files["items.json"]));
      const vectors = embeddings(items);
      const scope = [{ skillVersionId: version.id, indexScope: version.artifacts, itemCount: version.itemCount }];
      const where: Where = { $and: [
        { type: "scenario_item" }, { orgId: ORG }, skillScopeWhere(scope),
        scenarioScopeWhere([{ slug: `skill:${version.artifacts}`, version: 1 }]),
      ] };
      const indexed = await collection.get({ where, limit: 5000, include: ["metadatas"] });
      if (indexed.ids.length !== version.itemCount || await MainCollectionService.skillItemCount(ORG, version.id, version.artifacts) !== version.itemCount) throw new Error("Immutable package vector scope/count differs");
      for (const metadata of indexed.metadatas) {
        if (metadata?.orgId !== ORG || metadata.skillVersionId !== version.id || metadata.skillIndexScope !== version.artifacts) throw new Error("Cross-package vector scope detected");
      }
      if (items.length) {
        const query = await collection.query({ queryEmbeddings: [vectors[0]], where, nResults: Math.min(3, items.length), include: ["metadatas"] });
        if (!query.ids[0]?.length || query.ids[0].some((id) => !indexed.ids.includes(id))) throw new Error("Native vector query escaped its immutable package scope");
        const hits = await MainCollectionService.searchSkillItems(ORG, scope, items[0].text, { queryEmbedding: Promise.resolve(vectors[0]) });
        if (!hits.length || hits.some((hit) => !items.some((item) => item.text === hit.text))) throw new Error("Native managed retrieval failed with original imported query vectors");
      }
      retrieval.push({ versionId: version.id, ownerSlug: version.skill.ownerSlug, items: version.itemCount, queried: items.length > 0 });
    }
    const report = { counts, current, historicalUnavailable: unavailable, originalFilesVerified: originalFiles,
      originalMissingEmbeddingInputs: missingInputs.size, retrieval,
      databaseAccess: "semantic read-only verification; native resolvers take row locks in a read-write transaction",
      sessionCreation: "not attempted; assigned helper does not freeze pins", modelCalls: 0 };
    await saveReport(report);
    console.log(JSON.stringify({ experiencesVerified: current.length, mappedVersions: counts.mappedVersions,
      currentPackagesVerified: current.filter((entry) => entry.versionId).length, currentTwinExamples: counts.currentTwinItems.reduce((sum, count) => sum + count, 0),
      mainCatalogSkills: catalog.catalog.length,
      originalFilesVerified: originalFiles, originalMissingEmbeddingInputs: missingInputs.size, historicalUnavailableVersions: unavailable.length,
      packageScopesQueried: retrieval.filter((entry) => entry.queried).length, sessionsCreated: 0, modelCalls: 0 }));
  } finally {
    await db.$disconnect();
  }
}

if (import.meta.main) await main();

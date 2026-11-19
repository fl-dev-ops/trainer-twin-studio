import { createHash } from "node:crypto";
import { db, withLock } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { MainCollectionService } from "@/lib/main-collection";
import { roleplayBuilderSchema, roleplayItemSchema } from "@/lib/roleplay/skill";
import { scenarioItemSchema, scenarioManifestSchema, twinSkillManifestSchema } from "@/lib/scenario-ingest";
import { getObjectText, orgOwnKey } from "@/lib/s3";
import { countSources } from "@/lib/skill-sources";
import { skillPackageHash, verifySkillEnvelope, type SkillFiles, type SkillFormat } from "@/lib/skills";
import { stableJson } from "@/lib/stable-json";
import { ownershipLock } from "@/lib/skill-ownership";

type Tx = Prisma.TransactionClient;
type Candidate = { slug: string; version: number; projections: Prisma.JsonValue[]; current: boolean; required: boolean };
export type SkillMigrationOptions = {
  batchSize?: number; after?: string; check?: boolean; apply?: boolean;
  importedEmbeddings?: (items: Package["items"]) => number[][];
};
export type SkillMigrationEntry = {
  slug: string; agentVersion: number; current: boolean; required: boolean;
  status: "verified" | "imported" | "unmapped" | "failed";
  contentHash?: string; skillVersionId?: string; artifacts?: string; items?: number; error?: string;
};
export type SkillMigrationReport = {
  orgId: string; mode: "dry-run" | "apply" | "check";
  /** Package-coverage hash excludes mutable Agent settings; cutover must separately lock/recheck Agent state. */
  hash: string;
  entries: SkillMigrationEntry[]; next: string | null; complete: boolean;
  currentGaps: string[]; requiredGaps: string[]; historicalGaps: string[];
};

function refuse(message: string): never { throw new Error(message); }
function object(value: Prisma.JsonValue | undefined): Prisma.JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
const cursor = (slug: string, version: number) => Buffer.from(JSON.stringify([slug, version])).toString("base64url");

async function candidates(orgId: string, opts: SkillMigrationOptions) {
  const size = opts.batchSize ?? 50;
  if (!Number.isSafeInteger(size) || size < 1 || size > 500) refuse("batchSize must be between 1 and 500.");
  let slug = "", version = 0;
  if (opts.after) {
    const decoded: unknown = JSON.parse(Buffer.from(opts.after, "base64url").toString());
    if (!Array.isArray(decoded) || decoded.length !== 2 || typeof decoded[0] !== "string" || !Number.isSafeInteger(decoded[1])) refuse("Invalid migration cursor.");
    [slug, version] = decoded;
  }
  const rows = await db.$queryRaw<Candidate[]>`
    WITH refs AS (
      SELECT slug, version, data, true AS current, false AS required FROM "Agent"
      WHERE "orgId" = ${orgId} AND (data ? 'skill' OR "primarySkillId" IS NOT NULL)
      UNION ALL
      SELECT "entitySlug", version, data, false, false FROM "SpecVersion"
      WHERE "orgId" = ${orgId} AND "entityType" = 'agents' AND data ? 'skill'
      UNION ALL
      SELECT a.slug, m."agentVersion", NULL::jsonb, a.version = m."agentVersion", false
      FROM "AgentSkillVersion" m JOIN "Agent" a ON a.id = m."agentId"
      WHERE m."orgId" = ${orgId} AND a."orgId" = ${orgId}
      UNION ALL
      SELECT "agentSlug", "agentVersion", "compiledSnapshot"->'agent'->'data', false, true
      FROM "InterviewSession" s WHERE "orgId" = ${orgId} AND (
        "compiledSnapshot"->'agent'->'data' ? 'skill' OR EXISTS (
          SELECT 1 FROM "AgentSkillVersion" m
          WHERE m."orgId" = ${orgId} AND m."agentId" = s."agentId" AND m."agentVersion" = s."agentVersion"
        ))
      UNION ALL
      SELECT s."agentSlug", s."agentVersion", NULL::jsonb, false, true
      FROM "InterviewSession" s JOIN "Agent" a ON a.id = s."agentId"
      WHERE s."orgId" = ${orgId} AND (s."compiledSnapshot" IS NULL OR s."compiledSnapshot" = 'null'::jsonb) AND (
        EXISTS (SELECT 1 FROM "SpecVersion" h WHERE h."orgId" = ${orgId} AND h."entityType" = 'agents'
          AND h."entitySlug" = s."agentSlug" AND h.version = s."agentVersion" AND h.data ? 'skill')
        OR ((a."primarySkillId" IS NOT NULL OR a.data ? 'skill') AND (
          a.version = s."agentVersion" OR NOT EXISTS (
            SELECT 1 FROM "SpecVersion" h WHERE h."orgId" = ${orgId} AND h."entityType" = 'agents'
            AND h."entitySlug" = s."agentSlug" AND h.version = s."agentVersion"
          )
        ))
      )
      UNION ALL
      SELECT ref->>'slug', (ref->>'version')::integer, NULL::jsonb, false, true
      FROM "InterviewSession", LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof("compiledSnapshot"->'twinSkills') = 'array'
        THEN "compiledSnapshot"->'twinSkills' ELSE '[]'::jsonb END) ref
      WHERE "orgId" = ${orgId} AND ref ? 'slug' AND ref ? 'version'
    )
    SELECT slug, version, COALESCE(jsonb_agg(DISTINCT data) FILTER (WHERE data IS NOT NULL), '[]'::jsonb) AS projections,
      bool_or(current) AS current, bool_or(required) AS required FROM refs
    WHERE (slug, version) > (${slug}, ${version})
    GROUP BY slug, version ORDER BY slug, version LIMIT ${size + 1}`;
  return { rows: rows.slice(0, size), more: rows.length > size };
}

async function readPackage(orgId: string, row: Candidate, kind: string) {
  const projections = row.projections.map(object).filter((v): v is Prisma.JsonObject => v !== null && "skill" in v);
  const mapping = await db.agentSkillVersion.findFirst({
    where: { orgId, agentVersion: row.version, agent: { orgId, slug: row.slug } },
    include: { version: { include: { skill: true } } },
  });
  if (mapping) {
    const version = mapping.version;
    if (version.skill.orgId !== orgId || version.skill.ownerSlug !== row.slug || version.status !== "ready"
      || (kind === "ROLEPLAY") !== ["builder-roleplay", "authored-roleplay"].includes(version.format)) {
      refuse("Mapped package organization, owner, lifecycle or experience format conflicts with the Agent.");
    }
    verifySkillEnvelope(version);
    projections.push({ skill: version.skillText, scenario: version.manifest, artifacts: version.artifacts,
      filesHash: version.contentHash, source: version.format === "builder-roleplay" ? "roleplay-skill" : "scenario-ingest" });
  }
  if (!projections.length) refuse("Session pin has no surviving Agent, SpecVersion or package snapshot. Restore the original history before retrying.");
  projections.sort((a, b) => String(a.artifacts).localeCompare(String(b.artifacts)));
  const data = projections[0];
  const manifest = object(data.scenario);
  if (!manifest || typeof data.skill !== "string" || !data.skill) refuse("Missing skill text or manifest projection.");
  const format: SkillFormat = kind === "ROLEPLAY"
    ? data.source === "roleplay-skill" ? "builder-roleplay" : "authored-roleplay"
    : typeof manifest.skill === "string" ? "twin" : "legacy-twin";
  const artifacts = orgOwnKey(orgId, data.artifacts);
  if (!artifacts || !orgOwnKey(orgId, `${artifacts}/SKILL.md`)) refuse("Missing or cross-organization artifact prefix; restore the original package reference.");
  const prefixes = new Set<string>();
  for (const projection of projections) {
    if (projection.skill !== data.skill || stableJson(projection.scenario) !== stableJson(manifest)
      || (kind === "ROLEPLAY" && (projection.source === "roleplay-skill") !== (format === "builder-roleplay"))) {
      refuse("Conflicting historical projections for the same Agent version.");
    }
    const prefix = orgOwnKey(orgId, projection.artifacts);
    if (!prefix || !orgOwnKey(orgId, `${prefix}/SKILL.md`)) refuse("Missing or cross-organization artifact prefix; restore the original package reference.");
    prefixes.add(prefix);
  }
  const manifestName = format === "twin" ? "skill.json" : "scenario.json";
  let files: SkillFiles | undefined;
  for (const prefix of prefixes) {
    const original: SkillFiles = {};
    for (const name of ["SKILL.md", manifestName, "items.json", "patterns.md"]) {
      try { original[name] = await getObjectText(`${prefix}/${name}`); }
      catch (error) {
        if (name === "patterns.md" && error instanceof Error && error.name === "NoSuchKey") continue;
        throw new Error(`Cannot read ${prefix}/${name}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}. Restore the object or repair storage access.`, { cause: error });
      }
    }
    if (files && stableJson(files) !== stableJson(original)) refuse("Historical artifact prefixes contain different original package bytes.");
    files = original;
  }
  if (!files) refuse("No verified original package files.");
  const rawManifest: Prisma.JsonValue = JSON.parse(files[manifestName]);
  const parsedManifest = format === "twin" ? twinSkillManifestSchema.parse(rawManifest) : scenarioManifestSchema.parse(rawManifest);
  if (format === "builder-roleplay") roleplayBuilderSchema.omit({ learnerGoals: true, rubric: true }).parse(object(rawManifest)?.roleplay);
  const rawItems: unknown = JSON.parse(files["items.json"]);
  const items = format === "builder-roleplay" ? roleplayItemSchema.array().max(5000).parse(rawItems)
    : scenarioItemSchema.array().max(5000).parse(rawItems);
  if (new Set(items.map((item) => item.id)).size !== items.length) refuse("Duplicate item IDs would lose examples during indexing.");
  if (format === "twin" && items.some((item) => item.role !== "trainer")) refuse("Twin package contains non-trainer examples.");
  const contentHash = skillPackageHash(format, files);
  const legacyHash = createHash("sha256").update(JSON.stringify(rawItems)).update("\0").update(files["patterns.md"] ?? "").digest("hex").slice(0, 16);
  for (const projection of projections) {
    if (projection.filesHash !== undefined && projection.filesHash !== contentHash && projection.filesHash !== legacyHash) {
      refuse("Saved filesHash does not match original items/evidence or the canonical package. Restore verified original files.");
    }
  }
  verifySkillEnvelope({ format, files, contentHash, skillText: data.skill, manifest, itemCount: items.length });
  return { files, format, manifest, skillText: data.skill, contentHash, items, artifacts,
    scenarioId: "skill" in parsedManifest ? String(parsedManifest.skill) : String(parsedManifest.scenario) };
}

type Package = Awaited<ReturnType<typeof readPackage>>;
async function provenance(tx: Tx, orgId: string, agentId: string, version: number, pkg: Package) {
  const rows = await tx.skillSource.findMany({ where: { orgId, agentId, version }, orderBy: { documentId: "asc" } });
  const counts = countSources(pkg.items);
  for (const row of rows) {
    if (counts.get(row.documentId) !== row.items) refuse(`Source ${row.documentId} count disagrees with items.json.`);
  }
  return rows.map(({ documentId, title, items }) => ({ documentId, title, items }));
}

async function mappedVersion(tx: Tx, orgId: string, agentId: string, row: Candidate, pkg: Package) {
  const originalVersions = await tx.skillVersion.findMany({
    where: { artifacts: pkg.artifacts, status: "ready", skill: { orgId, ownerSlug: row.slug } },
    select: { id: true, contentHash: true, format: true },
  });
  if (originalVersions.length > 1) refuse(`Ambiguous ready packages share original artifact prefix ${pkg.artifacts}. Reconcile duplicate registry identities explicitly.`);
  if (originalVersions.some((version) => version.contentHash !== pkg.contentHash || version.format !== pkg.format)) {
    refuse("Original artifact prefix is already registered with a different package hash or format.");
  }
  const mapping = await tx.agentSkillVersion.findUnique({ where: { agentId_agentVersion: { agentId, agentVersion: row.version } } });
  const versions = mapping
    ? await tx.skillVersion.findMany({ where: { id: mapping.skillVersionId }, include: { skill: true, sources: true } })
    : await tx.skillVersion.findMany({ where: { contentHash: pkg.contentHash, status: "ready",
      skill: { orgId, ownerSlug: row.slug } }, include: { skill: true, sources: true }, orderBy: { version: "asc" } });
  let sources = await provenance(tx, orgId, agentId, row.version, pkg);
  const version = versions[0];
  if (version) {
    if (version.skill.orgId !== orgId || version.skill.ownerSlug !== row.slug || version.contentHash !== pkg.contentHash) refuse("Existing Agent mapping conflicts with the verified package.");
    if (!orgOwnKey(orgId, `${version.artifacts}/SKILL.md`)) refuse("Mapped package artifact prefix is outside the organization.");
    verifySkillEnvelope(version);
    if (!sources.length) {
      const counts = countSources(pkg.items);
      sources = version.sources.map(({ orgId: sourceOrg, documentId, title, items }) => {
        if (sourceOrg !== orgId || counts.get(documentId) !== items) refuse("Mapped package provenance disagrees with its original items or organization.");
        return { documentId, title, items };
      }).sort((a, b) => a.documentId.localeCompare(b.documentId));
    }
    if (version.artifacts !== pkg.artifacts) {
      for (const [name, bytes] of Object.entries(pkg.files)) {
        if (await getObjectText(`${version.artifacts}/${name}`) !== bytes) refuse(`Mapped package object ${version.artifacts}/${name} differs from verified original bytes.`);
      }
    }
    if (version.sources.length && stableJson(version.sources.map(({ documentId, title, items }) => ({ documentId, title, items })).sort((a, b) => a.documentId.localeCompare(b.documentId))) !== stableJson(sources)) {
      refuse("Package provenance conflicts across Agent versions. Resolve saved source titles/counts explicitly; no provenance was overwritten.");
    }
  }
  return { version, mapping, sources };
}

async function importPackage(orgId: string, row: Candidate, pkg: Package, capturedAgent: { id: string; updatedAt: Date }, embeddings?: number[][]) {
  const claim = await withLock([ownershipLock(orgId), `agent:${row.slug}`], async (tx) => {
    const existing = await mappedVersion(tx, orgId, capturedAgent.id, row, pkg);
    if (existing.version) {
      const version = existing.version;
      const rebuild = version.indexStatus !== "ready"
        || await MainCollectionService.skillItemCount(orgId, version.id, version.artifacts) !== version.itemCount;
      const claimed = rebuild ? await tx.skillVersion.update({ where: { id: version.id },
        data: { indexGeneration: { increment: 1 }, indexStatus: "pending", failure: null } }) : version;
      return { version: claimed, generation: existing.version.skill.generation, rebuild };
    }
    const skill = await tx.skill.upsert({ where: { orgId_ownerSlug: { orgId, ownerSlug: row.slug } },
      create: { orgId, ownerSlug: row.slug, name: String(pkg.manifest.name) }, update: {} });
    let version = await tx.skillVersion.findFirst({ where: { skillId: skill.id, contentHash: pkg.contentHash, artifacts: pkg.artifacts, status: { in: ["pending", "failed"] } } });
    if (version && version.publicationGeneration !== 0) refuse("A live publication owns this pending original artifact. Retry migration after publication/recovery completes.");
    if (!version) {
      version = await tx.skillVersion.create({ data: {
        skillId: skill.id, version: skill.nextVersion, format: pkg.format, contentHash: pkg.contentHash,
        files: pkg.files, skillText: pkg.skillText, manifest: pkg.manifest, artifacts: pkg.artifacts, itemCount: pkg.items.length,
      } });
      await tx.skill.update({ where: { id: skill.id }, data: { nextVersion: { increment: 1 } } });
    }
    version = await tx.skillVersion.update({ where: { id: version.id },
      data: { status: "pending", indexStatus: "pending", indexGeneration: { increment: 1 }, failure: null } });
    return { version, generation: skill.generation, rebuild: true };
  });
  try {
    // Provider work stays bounded by the same owner lock as publication. The immutable
    // version/scope pair never collides with compatibility or live publication indexes.
    return await withLock([ownershipLock(orgId), `agent:${row.slug}`], async (tx) => {
      const version = await tx.skillVersion.findUniqueOrThrow({ where: { id: claim.version.id } });
      if (version.indexGeneration !== claim.version.indexGeneration
        || version.publicationGeneration !== claim.version.publicationGeneration
        || version.artifacts !== claim.version.artifacts) refuse("Index or publication claim superseded; retry migration.");
      if (!orgOwnKey(orgId, `${version.artifacts}/SKILL.md`)) refuse("Index artifact scope is outside the organization.");
      verifySkillEnvelope(version);
      const { sources } = await mappedVersion(tx, orgId, capturedAgent.id, row, pkg);
      if (claim.rebuild) {
        const count = embeddings === undefined
          ? await MainCollectionService.writeSkillItems(orgId, version.id, pkg.scenarioId, pkg.items, version.artifacts)
          : await MainCollectionService.writeSkillItems(orgId, version.id, pkg.scenarioId, pkg.items, version.artifacts, { embeddings });
        if (count !== version.itemCount) refuse("Rebuilt index count does not match the verified original package.");
        const done = await tx.skillVersion.updateMany({ where: { id: version.id, indexGeneration: version.indexGeneration },
          data: { status: "ready", indexStatus: "ready", failure: null } });
        if (done.count !== 1) refuse("Index claim superseded; retry migration.");
      }
      const existingSources = await tx.skillVersionSource.findMany({ where: { skillVersionId: version.id } });
      if (!existingSources.length && sources.length) await tx.skillVersionSource.createMany({
        data: sources.map((source) => ({ ...source, orgId, skillVersionId: version.id })),
      });
      const mapping = await tx.agentSkillVersion.findUnique({ where: { agentId_agentVersion: { agentId: capturedAgent.id, agentVersion: row.version } } });
      if (mapping && mapping.skillVersionId !== version.id) refuse("A concurrent migration mapped this Agent version to another package.");
      if (!mapping) await tx.agentSkillVersion.create({
        data: { orgId, agentId: capturedAgent.id, agentVersion: row.version, skillVersionId: version.id } });
      const agent = await tx.agent.findUniqueOrThrow({ where: { id: capturedAgent.id } });
      const skill = await tx.skill.findUniqueOrThrow({ where: { id: version.skillId } });
      if (row.current && agent.version === row.version && agent.updatedAt.getTime() === capturedAgent.updatedAt.getTime()
        && object(agent.data)?.artifacts === pkg.artifacts && skill.generation === claim.generation) {
        if (agent.primarySkillId && agent.primarySkillId !== skill.id) refuse("Agent now belongs to a different managed skill.");
        // Do not redirect a managed current package to a byte-identical historical copy.
        if (!skill.currentVersionId || skill.currentVersionId === version.id) {
          await tx.skill.update({ where: { id: skill.id }, data: { currentVersionId: version.id } });
        }
        await tx.agent.update({ where: { id: agent.id }, data: { primarySkillId: skill.id } });
      }
      return version.id;
    }, { timeout: 120_000, maxWait: 120_000 });
  } catch (error) {
    await withLock([ownershipLock(orgId), `agent:${row.slug}`], async (tx) => {
      await tx.skillVersion.updateMany({ where: { id: claim.version.id, status: "pending", indexGeneration: claim.version.indexGeneration,
        publicationGeneration: claim.version.publicationGeneration, artifacts: claim.version.artifacts },
        data: { status: "failed", indexStatus: "failed", failure: String(error).slice(0, 500) } });
      await tx.skillVersion.updateMany({ where: { id: claim.version.id, status: "ready", indexGeneration: claim.version.indexGeneration, indexStatus: "pending",
        publicationGeneration: claim.version.publicationGeneration, artifacts: claim.version.artifacts },
        data: { indexStatus: "failed", failure: String(error).slice(0, 500) } });
    });
    throw error;
  }
}

export async function migrateSkills(orgId: string, opts: SkillMigrationOptions = {}): Promise<SkillMigrationReport> {
  if (opts.apply && opts.check) refuse("--apply and --check are mutually exclusive.");
  await db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { id: true } });
  const page = await candidates(orgId, opts);
  const entries: SkillMigrationEntry[] = [];
  for (const row of page.rows) {
    const entry: SkillMigrationEntry = { slug: row.slug, agentVersion: row.version, current: row.current, required: row.required, status: "failed" };
    entries.push(entry);
    try {
      const agent = await db.agent.findFirst({ where: { orgId, slug: row.slug } });
      if (!agent) refuse("Owning Agent is missing; restore its original identity before importing history.");
      const pkg = await readPackage(orgId, row, agent.kind);
      Object.assign(entry, { contentHash: pkg.contentHash, artifacts: pkg.artifacts, items: pkg.items.length });
      if (opts.importedEmbeddings) await mappedVersion(db, orgId, agent.id, row, pkg);
      const embeddings = opts.importedEmbeddings?.(pkg.items);
      if (opts.apply) {
        entry.skillVersionId = await importPackage(orgId, row, pkg, agent, embeddings);
        entry.status = "imported";
      } else {
        const found = await mappedVersion(db, orgId, agent.id, row, pkg);
        entry.skillVersionId = found.version?.id;
        entry.status = found.mapping && found.version?.status === "ready" && found.version.indexStatus === "ready"
          && await MainCollectionService.skillItemCount(orgId, found.version.id, found.version.artifacts) === pkg.items.length ? "verified" : "unmapped";
        if (entry.status === "verified" && row.current
          && agent.primarySkillId !== found.version?.skillId) {
          entry.status = "unmapped";
          entry.error = "Current Agent is not attached to its verified package owner.";
        }
      }
    } catch (error) {
      entry.status = "failed";
      entry.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  }
  const gap = (entry: SkillMigrationEntry) => entry.status !== "verified" && entry.status !== "imported";
  const key = (entry: SkillMigrationEntry) => `${entry.slug}@${entry.agentVersion}`;
  const last = page.rows.at(-1);
  return { orgId, mode: opts.apply ? "apply" : opts.check ? "check" : "dry-run",
    hash: inventoryHash(entries),
    entries, next: page.more && last ? cursor(last.slug, last.version) : null, complete: !page.more && !opts.after,
    currentGaps: entries.filter((entry) => entry.current && gap(entry)).map(key),
    requiredGaps: entries.filter((entry) => entry.required && gap(entry)).map(key),
    historicalGaps: entries.filter((entry) => !entry.current && !entry.required && gap(entry)).map(key) };
}

export function inventorySkills(orgId: string, opts: Omit<SkillMigrationOptions, "apply"> = {}) {
  return migrateSkills(orgId, { ...opts, apply: false });
}

function inventoryHash(entries: SkillMigrationEntry[]) {
  return createHash("sha256").update(stableJson(entries.map((entry) => ({
    slug: entry.slug, agentVersion: entry.agentVersion, current: entry.current, required: entry.required,
    contentHash: entry.contentHash ?? null, artifacts: entry.artifacts ?? null, items: entry.items ?? null,
  })))).digest("hex");
}

export async function checkSkillMigrationCoverage(orgId: string, opts: { batchSize?: number } = {}): Promise<SkillMigrationReport> {
  const entries: SkillMigrationEntry[] = [];
  let after: string | undefined;
  let report: SkillMigrationReport;
  do {
    report = await inventorySkills(orgId, { ...opts, after, check: true });
    entries.push(...report.entries);
    after = report.next ?? undefined;
  } while (after);
  const gaps = entries.filter((entry) => entry.status !== "verified");
  const key = (entry: SkillMigrationEntry) => `${entry.slug}@${entry.agentVersion}`;
  return { ...report, entries, hash: inventoryHash(entries), complete: true,
    currentGaps: gaps.filter((entry) => entry.current).map(key),
    requiredGaps: gaps.filter((entry) => entry.required).map(key),
    historicalGaps: gaps.filter((entry) => !entry.current && !entry.required).map(key) };
}

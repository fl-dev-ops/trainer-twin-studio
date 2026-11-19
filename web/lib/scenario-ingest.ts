import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db, withLock } from "@/lib/db";
import { stableJson } from "@/lib/stable-json";
import { preserveAgentSkillVersion, recordPublicationSkillLinks } from "@/lib/skill-version-links";
import { hydrateAgentSkill } from "@/lib/skill-history";
import { ownershipLock, packageFieldsOmitted, skillOwnership } from "@/lib/skill-ownership";
import type { Prisma } from "@/lib/generated/prisma/client";
import { MainCollectionService } from "@/lib/main-collection";
import { putObject, s3Configured, scenarioRunPrefix } from "@/lib/s3";
import { activateSkillVersion, failSkillVersion, reserveSkillVersion, skillPackageHash, skillRefusals, uploadSkillFiles, verifySkillEnvelope, type SkillFiles, type SkillFormat } from "@/lib/skills";
import type { BeforeSettings } from "@/lib/context-upload";
import { renderRoleplay, roleplayBuilderSchema, type RoleplayItem } from "@/lib/roleplay/skill";
import { draftBrief } from "@/lib/roleplay/brief";
import { validSlug } from "@/lib/specs";
import type { ToolSettings } from "@/lib/agent-tools";

/** Agent.data.source of a role play built in the builder (twin skills: "scenario-ingest"). */
export const ROLEPLAY_SOURCE = "roleplay-skill";
/** Agent.data.source of a twin skill from the copilot's twin-creator (knowledge, decisions, approach on one topic). */
export const TWIN_SKILL_SOURCE = "twin-creator";

/**
 * Stores a scenario produced by the scenario-ingest agent (SKILL.md + scenario.json + items.json)
 * as a managed SkillVersion attached to a twin or role-play Agent.
 * Markdown is verbatim; JSON objects use fileText's existing serialization.
 *
 * Where each file lives:
 *   S3        every file as produced (SKILL.md, scenario.json, items.json, patterns.md; per run:
 *             plan.json, report.md, specs/*.md). Package files have their own immutable version.
 *   Postgres  SkillVersion holds package identity/bytes/projections; Agent.data remains a compatibility projection.
 *   Chroma    items.json as managed and legacy-compatible `scenario_item` scopes.
 */

const kebab = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be kebab-case");

/** scenario.json, as written by scenario-ingest's save_skill. */
export const scenarioManifestSchema = z.looseObject({
  scenario: kebab,
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(1024),
  trainer_role: z.string().min(1).max(100),
  learner_role: z.string().min(1).max(100),
  steps: z
    .array(
      z.looseObject({
        id: kebab,
        name: z.string().min(1).max(200),
        trainer_moves: z.array(z.string()),
        learner_moves: z.array(z.string()),
      }),
    )
    .min(1)
    .max(30),
});
export type ScenarioManifest = z.infer<typeof scenarioManifestSchema>;

/** One entry of items.json. */
export const scenarioItemSchema = z.looseObject({
  id: z.string().min(1).max(300),
  role: z.enum(["trainer", "learner"]),
  context: z.string().max(2000),
  text: z.string().min(1).max(8000),
  metadata: z.looseObject({
    step: z.string().max(100).optional(),
    move: z.string().max(100).optional(),
    source: z.string().max(300).optional(),
    kind: z.string().max(40).optional(),
    ref: z.number().int().nullable().optional(),
    words: z.number().int().optional(),
  }),
});
export type ScenarioItem = z.infer<typeof scenarioItemSchema>;

/** Safe as an S3 path segment and stable across retries of the same ingest run. */
const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, "letters, digits, dot, dash or underscore");

export const scenarioIngestSchema = z.object({
  /** The trainer persona the scenario speaks as; must already exist in the org. */
  personaSlug: z.string().min(1),
  /** SKILL.md exactly as published (YAML header + Markdown body). */
  skill: z.string().min(1).max(200_000),
  scenario: scenarioManifestSchema,
  items: z.array(scenarioItemSchema).max(5000),
  /** patterns.md: reviewer evidence, archived to S3 only. */
  patterns: z.string().max(1_000_000).optional(),
  /** The ingest run this scenario came from (see /api/internal/scenario-runs). */
  runId: runId.optional(),
  /**
   * Which module the copilot built it for: its roleplay-creator publishes ROLEPLAY (a practice session the AI leads),
   * anything else a TWIN skill. Default TWIN, so an older copilot keeps working.
   */
  kind: z.enum(["TWIN", "ROLEPLAY"]).optional(),
});
export type ScenarioIngestInput = z.infer<typeof scenarioIngestSchema>;

/** One ingest run's files: plan.json, report.md and specs/<id>.md. */
export const scenarioRunSchema = z.object({
  runId,
  plan: z.looseObject({}),
  report: z.string().max(1_000_000),
  specs: z.record(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "spec ids are kebab-case"), z.string().max(1_000_000)).default({}),
});
export type ScenarioRunInput = z.infer<typeof scenarioRunSchema>;

/** Bearer check shared by the ingest routes. Its own secret: the ingest agent shouldn't hold the copilot one. */
export function ingestAuthorized(request: Request) {
  const expected = process.env.SCENARIO_INGEST_SECRET;
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

// The same serialization scenario-ingest uses for these files, so the S3 copies match byte for byte.
export const fileText = {
  scenario: (manifest: unknown) => `${JSON.stringify(manifest, null, 2)}\n`,
  items: (items: unknown) => `${JSON.stringify(items, null, 1)}\n`,
  plan: (plan: unknown) => `${JSON.stringify(plan, null, 1)}\n`,
};

/** SKILL.md without its `---` YAML header. Only for reading step goals; the stored skill keeps its header. */
export function skillBody(skill: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(skill);
  return (match ? skill.slice(match[0].length) : skill).trim();
}

/** The trainer's goal for one step: the first "**… goal:**" line in that step's section under "## Steps". */
export function stepGoal(body: string, stepId: string): string | undefined {
  const steps = body.slice(Math.max(0, body.indexOf("## Steps")));
  const sections = steps.split(/\n(?=###\s)/);
  const section = sections.find((s) => s.split("\n", 1)[0].includes(`\`${stepId}\``));
  return section?.match(/\*\*[^*\n]*goal:\*\*\s*(.+)/i)?.[1].trim();
}

/**
 * The Agent row for a scenario. `skill` and `scenario` are the ingestion files verbatim;
 * name/objective/stages are derived copies so the dashboard can list and describe the scenario.
 */
export function buildScenario(orgSlug: string, manifest: ScenarioManifest, skill: string) {
  const slug = `${orgSlug}-${manifest.scenario}`.toLowerCase();
  const body = skillBody(skill);
  const agentData = {
    id: slug,
    name: manifest.name,
    objective: manifest.description,
    stages: manifest.steps.map((step) => ({ id: step.id, name: step.name, objective: stepGoal(body, step.id) ?? step.name })),
    config: { context: { mode: "none", required: false } },
    // The chat runtime runs these scenarios from the playbook (see chat/agent/lib/brain.ts).
    source: "scenario-ingest",
    skill,
    scenario: manifest,
  };
  return { slug, agentData };
}

export class ScenarioIngestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const json = (value: unknown) => value as Prisma.InputJsonValue;

async function requireOrg(orgId: string) {
  if (!s3Configured) throw new ScenarioIngestError("Storage is not configured", 503);
  const org = await db.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true } });
  if (!org) throw new ScenarioIngestError("Organization not found", 404);
  return org;
}

/**
 * Data a During write carries over from the agent it replaces: Before and After belong to their own phases (configure
 * page, builder), and the intro video is provisioned separately. Without this a re-ingest dropped them.
 */
const KEPT_ACROSS_DURING_WRITES = ["introVideo", "before", "twinSettings", "after", "tools"] as const;

/**
 * Writes a skill package as an Agent of `kind` (twin skill or role play): S3 files, then Chroma items, then the
 * Postgres rows, so a failure never leaves a published agent without its files or items. Safe to call again:
 * unchanged content keeps the version. A twin and a role play never overwrite each other.
 */
/** What storeSkillAgent writes besides SKILL.md and the items: the agent's slug and data, and its manifest file. */
type SkillPackage = { slug: string; scenarioId: string; agentData: { name: string } & Record<string, unknown>; manifestFile: string; manifest: unknown };

async function storeSkillAgent(input: {
  org: { id: string; slug: string };
  kind: "TWIN" | "ROLEPLAY";
  personaId: string;
  /** A scenario (role play or older skill twin); or `built` for any other package (twin-creator skills). */
  manifest?: ScenarioManifest;
  built?: SkillPackage;
  skill: string;
  items: (ScenarioItem | RoleplayItem)[];
  patterns?: string;
  /** An update's change record, stored with a new version as changes.json (debugging only; not part of the version's content). */
  changes?: Record<string, unknown>;
  /** Agent.data keys on top of the derived ones (role play: source, after). */
  data?: Record<string, unknown>;
  runId?: string | null;
}) {
  const { org, kind } = input;
  const pkg: SkillPackage = input.built ?? {
    ...buildScenario(org.slug, input.manifest!, input.skill), scenarioId: input.manifest!.scenario, manifestFile: "scenario.json", manifest: input.manifest,
  };
  const { slug, agentData } = pkg;
  if (!validSlug(slug)) throw new ScenarioIngestError(`"${slug}" is not a valid scenario id`, 400);

  const files: SkillFiles = {
    "SKILL.md": input.skill,
    [pkg.manifestFile]: fileText.scenario(pkg.manifest),
    "items.json": fileText.items(input.items),
    ...(input.patterns !== undefined ? { "patterns.md": input.patterns } : {}),
  };
  const format: SkillFormat = kind === "ROLEPLAY"
    ? input.data?.source === ROLEPLAY_SOURCE ? "builder-roleplay" : "authored-roleplay"
    : input.built ? "twin" : "legacy-twin";
  const publicationLocks = [ownershipLock(org.id), `agent:${slug}`];
  const reserved = await withLock(publicationLocks, async (tx) => {
    const ownership = await skillOwnership(org.id, tx);
    const managed = ownership.mode === "managed";
    const linkOptions = { compatibilitySources: !managed };
    // Slugs are global: refuse to touch another org's rows before writing anything.
    const currentAgent = await tx.agent.findUnique({ where: { slug } });
    if (currentAgent && currentAgent.orgId !== org.id) {
      throw new ScenarioIngestError(`Scenario "${slug}" belongs to another organization`, 409);
    }
    if (currentAgent && currentAgent.kind !== kind) {
      throw new ScenarioIngestError(kind === "TWIN" ? `"${slug}" is a role play, not a twin skill` : `"${slug}" is a twin skill, not a role play`, 409);
    }

    const comparisonAgent = managed && currentAgent ? await hydrateAgentSkill(org.id, currentAgent, tx) : currentAgent;
    const previous = (comparisonAgent?.data ?? {}) as Record<string, unknown>;
    const kept = Object.fromEntries(KEPT_ACROSS_DURING_WRITES.filter((key) => previous[key] !== undefined).map((key) => [key, previous[key]]));
    const filesHash = skillPackageHash(format, files);
    const content = { ...agentData, ...kept, ...input.data, filesHash };
    const previousContent = Object.fromEntries(Object.entries(previous).filter(([key]) => key !== "artifacts"));
    const unchanged = Boolean(currentAgent) && currentAgent!.personaId === input.personaId && stableJson(previousContent) === stableJson(content);
    if (unchanged && currentAgent?.primarySkillId && !currentAgent.archivedAt) {
      const skill = await tx.skill.findUniqueOrThrow({ where: { id: currentAgent.primarySkillId }, include: { currentVersion: true } });
      if (skill.currentVersion?.contentHash === skillPackageHash(format, files) && skill.currentVersion.artifacts === previous.artifacts) {
        if (skill.currentVersion.status !== "ready" || skill.currentVersion.indexStatus !== "ready") throw skillRefusals.unavailable();
        await recordPublicationSkillLinks(tx, {
          orgId: org.id, agentId: currentAgent.id, agentVersion: currentAgent.version, skillVersionId: skill.currentVersion.id,
        }, input.items, linkOptions);
        if (managed && skill.generation <= currentAgent.version) {
          const settings = packageFieldsOmitted(currentAgent.data as Record<string, unknown>);
          if (stableJson(settings) !== stableJson(currentAgent.data)) {
            await tx.agent.update({ where: { id: currentAgent.id }, data: { data: json(settings) } });
          }
        }
        return { noop: true as const, agentVersion: currentAgent.version, artifacts: skill.currentVersion.artifacts };
      }
    }
    const publication = await reserveSkillVersion(tx, {
      orgId: org.id, slug, name: agentData.name, format, skill: input.skill,
      manifest: json(pkg.manifest), files, itemCount: input.items.length, agentVersion: currentAgent?.version ?? 0, unchanged,
      intentHash: createHash("sha256").update(stableJson({ content, personaId: input.personaId, changes: input.changes ?? null })).digest("hex"),
    });
    return {
      noop: false as const, ...publication, currentAgent, content, unchanged,
      agentVersion: unchanged ? currentAgent!.version : publication.generation,
    };
  });

  if (reserved.noop) {
    return { slug, name: agentData.name, version: reserved.agentVersion, created: false, items: input.items.length, artifacts: reserved.artifacts, runId: input.runId ?? null };
  }
  const { version: packageVersion, skillId, generation } = reserved;
  try {
    const stored = await withLock(publicationLocks, async (tx) => {
      const ownership = await skillOwnership(org.id, tx);
      const managed = ownership.mode === "managed";
      const linkOptions = { compatibilitySources: !managed };
      const currentAgent = await tx.agent.findUnique({ where: { slug } });
      const currentSkill = await tx.skill.findUniqueOrThrow({ where: { id: skillId } });
      if (currentSkill.generation !== generation) throw skillRefusals.superseded();
      let currentVersion = await tx.skillVersion.findUniqueOrThrow({ where: { id: packageVersion.id } });
      if (currentVersion.status === "ready" && currentVersion.indexStatus !== "ready") throw skillRefusals.unavailable();
      const comparisonAgent = managed && currentAgent ? await hydrateAgentSkill(org.id, currentAgent, tx) : currentAgent;
      if (currentAgent?.primarySkillId === skillId && currentSkill.currentVersionId === packageVersion.id
        && currentAgent.personaId === input.personaId && !currentAgent.archivedAt
        && stableJson(Object.fromEntries(Object.entries(comparisonAgent!.data as Record<string, unknown>).filter(([key]) => key !== "artifacts"))) === stableJson(reserved.content)) {
        await recordPublicationSkillLinks(tx, {
          orgId: org.id, agentId: currentAgent.id, agentVersion: currentAgent.version, skillVersionId: currentVersion.id,
        }, input.items, linkOptions);
        if (managed) {
          const settings = packageFieldsOmitted(currentAgent.data as Record<string, unknown>);
          if (stableJson(settings) !== stableJson(currentAgent.data)) {
            await tx.agent.update({ where: { id: currentAgent.id }, data: { data: json(settings) } });
          }
        }
        return { version: currentAgent.version, created: false, items: input.items.length, artifacts: currentVersion.artifacts, pruneBelow: 0 };
      }
      if (stableJson(currentAgent) !== stableJson(reserved.currentAgent)
        || currentAgent?.updatedAt.getTime() !== reserved.currentAgent?.updatedAt.getTime()) {
        throw skillRefusals.superseded();
      }
      verifySkillEnvelope(currentVersion);
      if (currentAgent && !reserved.unchanged) await preserveAgentSkillVersion(tx, currentAgent, linkOptions);
      if (currentVersion.status !== "ready") {
        currentVersion = await tx.skillVersion.update({
          where: { id: currentVersion.id }, data: { artifacts: `${packageVersion.artifacts}/attempt-${randomUUID()}` },
        });
        await uploadSkillFiles(currentVersion);
        if (input.changes) await putObject(`${currentVersion.artifacts}/changes.json`, JSON.stringify(input.changes, null, 1) + "\n", "application/json");
        await MainCollectionService.writeSkillItems(org.id, packageVersion.id, pkg.scenarioId, input.items, currentVersion.artifacts);
      }
      if (!reserved.unchanged) {
        await MainCollectionService.writeScenarioItems(org.id, slug, pkg.scenarioId, reserved.agentVersion, input.items);
      }
      await activateSkillVersion(tx, { skillId, generation, versionId: packageVersion.id });
      const artifacts = currentVersion.artifacts;
      const version = reserved.agentVersion;
      const data = managed ? packageFieldsOmitted(reserved.content) : { ...reserved.content, artifacts };
      const done = { version, created: !currentAgent, items: input.items.length, artifacts, pruneBelow: !managed && currentAgent && !reserved.unchanged ? currentAgent.version : 0 };
      if (!currentAgent) {
        const created = await tx.agent.create({
          data: { slug, name: agentData.name, version, personaId: input.personaId, kind, data: json(data), orgId: org.id, primarySkillId: skillId },
        });
        await recordPublicationSkillLinks(tx, { orgId: org.id, agentId: created.id, agentVersion: version, skillVersionId: currentVersion.id }, input.items, linkOptions);
        return done;
      }
      // Publishing onto an archived skill / role play brings it back (archive is a soft delete; the slug stays taken).
      if (reserved.unchanged) {
        await tx.agent.update({ where: { id: currentAgent.id }, data: { archivedAt: null, primarySkillId: skillId, data: json(data) } });
        await recordPublicationSkillLinks(tx, { orgId: org.id, agentId: currentAgent.id, agentVersion: version, skillVersionId: currentVersion.id }, input.items, linkOptions);
        return done;
      }
      // Same versioning as a dashboard publish: snapshot the old spec, bump the version.
      await tx.specVersion.create({
        data: {
          entityType: "agents", entitySlug: slug, version: currentAgent.version,
          data: json(managed ? packageFieldsOmitted(currentAgent.data as Record<string, unknown>) : currentAgent.data), orgId: org.id,
        },
      });
      await tx.agent.update({
        where: { id: currentAgent.id },
        data: { name: agentData.name, version, personaId: input.personaId, data: json(data), archivedAt: null, primarySkillId: skillId },
      });
      await recordPublicationSkillLinks(tx, { orgId: org.id, agentId: currentAgent.id, agentVersion: version, skillVersionId: currentVersion.id }, input.items, linkOptions);
      return done;
    }, { timeout: 120_000, maxWait: 120_000 });

    return { slug, name: agentData.name, version: stored.version, created: stored.created, items: stored.items, artifacts: stored.artifacts, runId: input.runId ?? null };
  } catch (error) {
    await withLock(publicationLocks, async (tx) => {
      await skillOwnership(org.id, tx);
      const version = await tx.skillVersion.findUniqueOrThrow({ where: { id: packageVersion.id } });
      if (version.publicationGeneration === generation) await failSkillVersion(packageVersion.id, error, tx);
    });
    throw error;
  }
}

/** Publishes authored scenario files; twins require an own persona, role plays may use any org persona. */
export async function ingestScenario(orgId: string, input: ScenarioIngestInput) {
  const kind = input.kind ?? "TWIN";
  const [org, persona] = await Promise.all([
    requireOrg(orgId),
    db.persona.findFirst({ where: { orgId, ...(kind === "TWIN" ? { isOwn: true } : {}), slug: { equals: input.personaSlug, mode: "insensitive" } }, select: { id: true } }),
  ]);
  if (!persona) throw new ScenarioIngestError(`Persona "${input.personaSlug}" was not found in this organization`, 404);
  return storeSkillAgent({
    org, kind, personaId: persona.id, manifest: input.scenario, skill: input.skill, items: input.items,
    patterns: input.patterns, runId: input.runId,
  });
}

/**
 * Publishes a ported interview (lib/interview-skill.ts) as its own authored role play, through the same publisher as
 * every package. The original no-skill agent is untouched; the port's slug is `<org>-<original slug>`.
 */
export async function publishInterviewSkill(orgId: string, input: {
  personaSlug: string;
  scenario: ScenarioManifest;
  skill: string;
  items: ScenarioItem[];
  settings: Record<string, unknown>;
}) {
  const [org, persona] = await Promise.all([
    requireOrg(orgId),
    db.persona.findFirst({ where: { orgId, slug: { equals: input.personaSlug, mode: "insensitive" } }, select: { id: true } }),
  ]);
  if (!persona) throw new ScenarioIngestError(`Persona "${input.personaSlug}" was not found in this organization`, 404);
  return storeSkillAgent({
    org, kind: "ROLEPLAY", personaId: persona.id, manifest: scenarioManifestSchema.parse(input.scenario), skill: input.skill, items: input.items,
    data: input.settings,
  });
}

/**
 * Publishes a role play written from requirements (lib/roleplay/brief.ts) through the shared publisher. The brief is
 * kept with the role play (`data.roleplayBrief`) so the copilot edits it rather than rewriting the skill. Refuses an
 * incomplete brief; the same brief republished is a no-op.
 */
export async function publishRoleplayBrief(orgId: string, input: { personaSlug: string; brief: unknown }) {
  const draft = draftBrief(input.brief);
  if (!draft.ok) throw new ScenarioIngestError(`The role play is not ready: ${draft.reasons.join(" ")}`, 400);
  const [org, persona] = await Promise.all([
    requireOrg(orgId),
    db.persona.findFirst({ where: { orgId, slug: { equals: input.personaSlug, mode: "insensitive" } }, select: { id: true } }),
  ]);
  if (!persona) throw new ScenarioIngestError(`Persona "${input.personaSlug}" was not found in this organization`, 404);
  return storeSkillAgent({
    org, kind: "ROLEPLAY", personaId: persona.id, manifest: scenarioManifestSchema.parse(draft.scenario), skill: draft.skill, items: draft.items,
    data: { roleplayBrief: draft.brief },
  });
}

/** skill.json, as written by the copilot's twin-creator: one topic and the situations it answers. No roles, no moves. */
export const twinSkillManifestSchema = z.looseObject({
  skill: kebab,
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(1024),
  situations: z.array(z.looseObject({ id: kebab, name: z.string().min(1).max(200) })).min(1).max(30),
});
export type TwinSkillManifest = z.infer<typeof twinSkillManifestSchema>;

export const twinSkillIngestSchema = z.object({
  /** The trainer's own persona the skill belongs to. */
  personaSlug: z.string().min(1),
  /** SKILL.md exactly as published. */
  skill: z.string().min(1).max(200_000),
  manifest: twinSkillManifestSchema,
  /** The trainer's own words only. */
  items: z.array(scenarioItemSchema.refine((item) => item.role === "trainer", "a twin skill holds only the trainer's words")).max(5000),
  patterns: z.string().max(1_000_000).optional(),
  /** An update's change record from the copilot (items added / removed, text edits): stored as the version's changes.json, for debugging. */
  changes: z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= 500_000, "changes is too large").optional(),
  runId: runId.optional(),
});
export type TwinSkillIngestInput = z.infer<typeof twinSkillIngestSchema>;

/**
 * The Agent row for a twin skill: its situations stand where a scenario's steps would (stages, playbook steps,
 * retrieval filters), and skill.json is kept under data.scenario, the agent's manifest.
 */
export function buildTwinSkill(orgSlug: string, manifest: TwinSkillManifest, skill: string): SkillPackage {
  const slug = `${orgSlug}-${manifest.skill}`.toLowerCase();
  return {
    slug,
    scenarioId: manifest.skill,
    manifestFile: "skill.json",
    manifest,
    agentData: {
      id: slug,
      name: manifest.name,
      objective: manifest.description,
      stages: manifest.situations.map((s) => ({ id: s.id, name: s.name, objective: s.name })),
      config: { context: { mode: "none", required: false } },
      source: TWIN_SKILL_SOURCE,
      skill,
      scenario: manifest,
    },
  };
}

/** Creates or updates a twin skill from the copilot's twin-creator. Always a TWIN of the trainer's own persona. */
export async function ingestTwinSkill(orgId: string, input: TwinSkillIngestInput) {
  const [org, persona] = await Promise.all([
    requireOrg(orgId),
    db.persona.findFirst({ where: { orgId, isOwn: true, slug: { equals: input.personaSlug, mode: "insensitive" } }, select: { id: true } }),
  ]);
  if (!persona) throw new ScenarioIngestError(`Persona "${input.personaSlug}" was not found in this organization`, 404);
  return storeSkillAgent({
    org, kind: "TWIN", personaId: persona.id, built: buildTwinSkill(org.slug, input.manifest, input.skill),
    skill: input.skill, items: input.items, patterns: input.patterns, changes: input.changes, runId: input.runId,
  });
}

/**
 * Creates (no slug) or updates a role play from the builder: rendered into SKILL.md + scenario.json + items.json +
 * after (lib/roleplay/skill.ts), stored like a skill twin with kind ROLEPLAY. The client is any persona of the org.
 * Returns the agent's slug (org-prefixed, like skill twins).
 */
export async function saveRoleplay(orgId: string, builder: unknown, slug?: string, before?: BeforeSettings, tools?: ToolSettings) {
  const parsed = roleplayBuilderSchema.safeParse(builder);
  if (!parsed.success) throw new ScenarioIngestError(parsed.error.issues[0]?.message ?? "Invalid role play", 400);
  const [org, persona] = await Promise.all([
    requireOrg(orgId),
    db.persona.findFirst({ where: { orgId, slug: parsed.data.persona }, select: { id: true, data: true } }),
  ]);
  if (!persona) throw new ScenarioIngestError(`Persona "${parsed.data.persona}" was not found in this organization`, 404);
  let shortSlug = slug ? slug.replace(new RegExp(`^${org.slug}-`), "") : roleplaySlug(parsed.data.name);
  if (!slug) {
    // New role play: never land on an existing agent (twin or role play) with the same name.
    for (let n = 2; await db.agent.findUnique({ where: { slug: `${org.slug}-${shortSlug}` } }); n++) shortSlug = `${roleplaySlug(parsed.data.name)}-${n}`;
  }
  const role = (persona.data as { role?: unknown } | null)?.role;
  const rendered = renderRoleplay(shortSlug, parsed.data, typeof role === "string" && role.trim() ? role.trim() : "Client");
  return storeSkillAgent({
    org, kind: "ROLEPLAY", personaId: persona.id,
    manifest: scenarioManifestSchema.parse(rendered.scenario), skill: rendered.skill, items: rendered.items,
    // Before and Tools are saved with the builder when given (the builder edits every tab); otherwise the agent's are kept.
    data: { source: ROLEPLAY_SOURCE, after: rendered.after, ...(before ? { before } : {}), ...(tools ? { tools } : {}) },
  });
}

/** kebab-case id from a role play's name ("The wait-and-see investor" → "the-wait-and-see-investor"). */
const roleplaySlug = (name: string) =>
  name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "role-play";

/** Archives one ingest run's files (plan.json, report.md, specs/*.md) to S3. Re-sending overwrites them. */
export async function ingestScenarioRun(orgId: string, input: ScenarioRunInput) {
  const org = await requireOrg(orgId);
  const prefix = scenarioRunPrefix(org.id, input.runId);
  const specs = Object.entries(input.specs);
  await Promise.all([
    putObject(`${prefix}/plan.json`, fileText.plan(input.plan), "application/json"),
    putObject(`${prefix}/report.md`, input.report, "text/markdown; charset=utf-8"),
    ...specs.map(([id, text]) => putObject(`${prefix}/specs/${id}.md`, text, "text/markdown; charset=utf-8")),
  ]);
  return { runId: input.runId, files: 2 + specs.length, prefix };
}

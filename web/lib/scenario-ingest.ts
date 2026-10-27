import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { MainCollectionService } from "@/lib/main-collection";
import { putObject, s3Configured, scenarioArtifactsPrefix, scenarioRunPrefix } from "@/lib/s3";
import { renderRoleplay, roleplayBuilderSchema, type RoleplayItem } from "@/lib/roleplay/skill";
import { validSlug } from "@/lib/specs";

/** Agent.data.source of a role play built in the builder (twin skills: "scenario-ingest"). */
export const ROLEPLAY_SOURCE = "roleplay-skill";

/**
 * Stores a scenario produced by the scenario-ingest agent (SKILL.md + scenario.json + items.json)
 * as a role-play Agent the app can run, plus its items in the org's Chroma collection.
 * Uses existing tables only: the skill lives in Agent.data, items in Chroma.
 * The files are stored exactly as ingestion produced them: schemas validate, they never trim,
 * default or drop anything (loose objects keep unknown keys).
 *
 * Where each file lives:
 *   S3        every file as produced (SKILL.md, scenario.json, items.json, patterns.md; per run:
 *             plan.json, report.md, specs/*.md), versioned with the Agent. The source of truth.
 *   Postgres  Agent.data.skill / .scenario for the runtime, plus an `artifacts` pointer to S3.
 *   Chroma    items.json as `scenario_item` records, for retrieval during sessions.
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

/** JSON with object keys sorted, so data read back from jsonb (which reorders keys) compares equal. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

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
 * The Agent + Domain rows for a scenario. `skill` and `scenario` are the ingestion files verbatim;
 * name/objective/stages are derived copies so the dashboard can list and describe the scenario.
 */
export function buildScenario(orgSlug: string, manifest: ScenarioManifest, skill: string) {
  const slug = `${orgSlug}-${manifest.scenario}`.toLowerCase();
  const domainSlug = `domain-${slug}`;
  const body = skillBody(skill);
  const agentData = {
    id: slug,
    name: manifest.name,
    objective: manifest.description,
    domain: domainSlug,
    stages: manifest.steps.map((step) => ({ id: step.id, name: step.name, objective: stepGoal(body, step.id) ?? step.name })),
    config: { context: { mode: "none", required: false } },
    // The chat runtime runs these scenarios from the playbook (see chat/agent/lib/brain.ts).
    source: "scenario-ingest",
    skill,
    scenario: manifest,
  };
  const domainData = { id: domainSlug, name: manifest.name, description: manifest.description };
  return { slug, domainSlug, agentData, domainData };
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
const KEPT_ACROSS_DURING_WRITES = ["introVideo", "before", "twinSettings", "after"] as const;

/**
 * Writes a skill package as an Agent of `kind` (twin skill or role play): S3 files, then Chroma items, then the
 * Postgres rows, so a failure never leaves a published agent without its files or items. Safe to call again:
 * unchanged content keeps the version. A twin and a role play never overwrite each other.
 */
async function storeSkillAgent(input: {
  org: { id: string; slug: string };
  kind: "TWIN" | "ROLEPLAY";
  personaId: string;
  manifest: ScenarioManifest;
  skill: string;
  items: (ScenarioItem | RoleplayItem)[];
  patterns?: string;
  /** Agent.data keys on top of the derived ones (role play: source, after). */
  data?: Record<string, unknown>;
  runId?: string | null;
}) {
  const { org, kind } = input;
  const { slug, domainSlug, agentData, domainData } = buildScenario(org.slug, input.manifest, input.skill);
  if (!validSlug(slug)) throw new ScenarioIngestError(`"${slug}" is not a valid scenario id`, 400);

  // Slugs are global: refuse to touch another org's rows before writing anything.
  const [currentAgent, currentDomain] = await Promise.all([
    db.agent.findUnique({ where: { slug } }),
    db.domain.findUnique({ where: { slug: domainSlug }, select: { orgId: true } }),
  ]);
  if ((currentAgent && currentAgent.orgId !== org.id) || (currentDomain && currentDomain.orgId !== org.id)) {
    throw new ScenarioIngestError(`Scenario "${slug}" belongs to another organization`, 409);
  }
  if (currentAgent && currentAgent.kind !== kind) {
    throw new ScenarioIngestError(kind === "TWIN" ? `"${slug}" is a role play, not a twin skill` : `"${slug}" is a twin skill, not a role play`, 409);
  }

  const previous = (currentAgent?.data ?? {}) as Record<string, unknown>;
  const kept = Object.fromEntries(KEPT_ACROSS_DURING_WRITES.filter((key) => previous[key] !== undefined).map((key) => [key, previous[key]]));
  const content = { ...agentData, ...kept, ...input.data };
  // Decide the version first: the S3 folder and the Agent row must carry the same number.
  const previousContent = Object.fromEntries(Object.entries(previous).filter(([key]) => key !== "artifacts"));
  const unchanged = Boolean(currentAgent) && currentAgent!.personaId === input.personaId && stableJson(previousContent) === stableJson(content);
  const version = currentAgent ? (unchanged ? currentAgent.version : currentAgent.version + 1) : 1;
  const artifacts = scenarioArtifactsPrefix(org.id, slug, version);
  const data = { ...content, artifacts };

  await Promise.all([
    putObject(`${artifacts}/SKILL.md`, input.skill, "text/markdown; charset=utf-8"),
    putObject(`${artifacts}/scenario.json`, fileText.scenario(input.manifest), "application/json"),
    putObject(`${artifacts}/items.json`, fileText.items(input.items), "application/json"),
    ...(input.patterns !== undefined ? [putObject(`${artifacts}/patterns.md`, input.patterns, "text/markdown; charset=utf-8")] : []),
  ]);
  const itemCount = await MainCollectionService.replaceScenarioItems(org.id, slug, input.manifest.scenario, input.items);

  await db.$transaction(async (tx) => {
    if (!currentDomain) {
      await tx.domain.create({ data: { slug: domainSlug, name: domainData.name, version: 1, data: json(domainData), orgId: org.id } });
    }
    if (!currentAgent) {
      await tx.agent.create({
        data: { slug, name: agentData.name, version, domainSlug, personaId: input.personaId, kind, data: json(data), orgId: org.id },
      });
      return;
    }
    if (unchanged) return;
    // Same versioning as a dashboard publish: snapshot the old spec, bump the version.
    await tx.specVersion.create({
      data: { entityType: "agents", entitySlug: slug, version: currentAgent.version, data: json(currentAgent.data), orgId: org.id },
    });
    await tx.agent.update({
      where: { id: currentAgent.id },
      data: { name: agentData.name, version, domainSlug, personaId: input.personaId, data: json(data) },
    });
  });

  return { slug, name: agentData.name, version, created: !currentAgent, items: itemCount, artifacts, runId: input.runId ?? null };
}

/** Creates or updates a skill twin from the scenario-ingest agent's files. */
export async function ingestScenario(orgId: string, input: ScenarioIngestInput) {
  const [org, persona] = await Promise.all([
    requireOrg(orgId),
    // Case-insensitive like the session context lookup: the ingest agent sends its source folder name ("vasanth").
    // A skill twin speaks as the user's own persona (also enforced by a DB trigger).
    db.persona.findFirst({ where: { orgId, isOwn: true, slug: { equals: input.personaSlug, mode: "insensitive" } }, select: { id: true } }),
  ]);
  if (!persona) throw new ScenarioIngestError(`Persona "${input.personaSlug}" was not found in this organization`, 404);
  return storeSkillAgent({
    org, kind: "TWIN", personaId: persona.id, manifest: input.scenario, skill: input.skill, items: input.items,
    patterns: input.patterns, runId: input.runId,
  });
}

/**
 * Creates (no slug) or updates a role play from the builder: rendered into SKILL.md + scenario.json + items.json +
 * after (lib/roleplay/skill.ts), stored like a skill twin with kind ROLEPLAY. The client is any persona of the org.
 * Returns the agent's slug (org-prefixed, like skill twins).
 */
export async function saveRoleplay(orgId: string, builder: unknown, slug?: string) {
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
    data: { source: ROLEPLAY_SOURCE, after: rendered.after },
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

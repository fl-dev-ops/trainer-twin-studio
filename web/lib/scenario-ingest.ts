import { z } from "zod";
import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { MainCollectionService } from "@/lib/main-collection";
import { validSlug } from "@/lib/specs";

/**
 * Stores a scenario produced by the scenario-ingest agent (SKILL.md + scenario.json + items.json)
 * as a role-play Agent the app can run, plus its items in the org's Chroma collection.
 * Uses existing tables only: the skill lives in Agent.data, items in Chroma.
 */

const kebab = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be kebab-case");

/** scenario.json, as written by scenario-ingest's save_skill. */
export const scenarioManifestSchema = z.object({
  scenario: kebab,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(1024),
  trainer_role: z.string().trim().min(1).max(100),
  learner_role: z.string().trim().min(1).max(100),
  steps: z
    .array(
      z.object({
        id: kebab,
        name: z.string().trim().min(1).max(200),
        trainer_moves: z.array(z.string()).default([]),
        learner_moves: z.array(z.string()).default([]),
      }),
    )
    .min(1)
    .max(30),
});
export type ScenarioManifest = z.infer<typeof scenarioManifestSchema>;

/** One entry of items.json. */
export const scenarioItemSchema = z.object({
  id: z.string().min(1).max(300),
  role: z.enum(["trainer", "learner"]),
  context: z.string().max(2000).default(""),
  text: z.string().trim().min(1).max(8000),
  metadata: z
    .object({
      step: z.string().max(100).optional(),
      move: z.string().max(100).optional(),
      source: z.string().max(300).optional(),
      kind: z.string().max(40).optional(),
      ref: z.number().int().nullable().optional(),
      words: z.number().int().optional(),
    })
    .default({}),
});
export type ScenarioItem = z.infer<typeof scenarioItemSchema>;

export const scenarioIngestSchema = z.object({
  /** The trainer persona the scenario speaks as; must already exist in the org. */
  personaSlug: z.string().min(1),
  /** SKILL.md exactly as published (YAML header + Markdown body). */
  skill: z.string().min(1).max(200_000),
  scenario: scenarioManifestSchema,
  items: z.array(scenarioItemSchema).max(5000).default([]),
});
export type ScenarioIngestInput = z.infer<typeof scenarioIngestSchema>;

/** SKILL.md without its `---` YAML header; the header only repeats name/description from scenario.json. */
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

/** The Agent + Domain rows for a scenario, in the shape the chat runtime already reads. */
export function buildScenario(orgSlug: string, manifest: ScenarioManifest, skill: string) {
  const slug = `${orgSlug}-${manifest.scenario}`.toLowerCase();
  const domainSlug = `domain-${slug}`;
  const body = skillBody(skill);
  const agentData = {
    id: slug,
    name: manifest.name,
    objective: manifest.description,
    domain: domainSlug,
    // The skill playbook is the instruction the runtime puts in front of the model.
    instruction: body,
    stages: manifest.steps.map((step) => ({ id: step.id, name: step.name, objective: stepGoal(body, step.id) ?? step.name })),
    config: { context: { mode: "none", required: false } },
    // Kept verbatim (roles, steps, moves) so the runtime can use the moves the items are tagged with.
    scenario: manifest,
    source: "scenario-ingest",
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

/** Creates or updates the scenario, then replaces its items. Safe to call again with the same files. */
export async function ingestScenario(orgId: string, input: ScenarioIngestInput) {
  const [org, persona] = await Promise.all([
    db.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true } }),
    db.persona.findFirst({ where: { orgId, slug: input.personaSlug }, select: { id: true } }),
  ]);
  if (!org) throw new ScenarioIngestError("Organization not found", 404);
  if (!persona) throw new ScenarioIngestError(`Persona "${input.personaSlug}" was not found in this organization`, 404);

  const { slug, domainSlug, agentData, domainData } = buildScenario(org.slug, input.scenario, input.skill);
  if (!validSlug(slug)) throw new ScenarioIngestError(`"${slug}" is not a valid scenario id`, 400);

  // Slugs are global: refuse to touch another org's rows before writing anything.
  const [currentAgent, currentDomain] = await Promise.all([
    db.agent.findUnique({ where: { slug } }),
    db.domain.findUnique({ where: { slug: domainSlug }, select: { orgId: true } }),
  ]);
  if ((currentAgent && currentAgent.orgId !== org.id) || (currentDomain && currentDomain.orgId !== org.id)) {
    throw new ScenarioIngestError(`Scenario "${slug}" belongs to another organization`, 409);
  }

  // Items first: if Chroma fails nothing is published, and a retry replaces them anyway.
  const itemCount = await MainCollectionService.replaceScenarioItems(org.id, slug, input.scenario.scenario, input.items);

  // An intro video is provisioned separately, so a re-ingest carries it forward (as publishSpecDraft does).
  const previousVideo = (currentAgent?.data as { introVideo?: unknown } | null | undefined)?.introVideo;
  const data = { ...agentData, ...(typeof previousVideo === "string" ? { introVideo: previousVideo } : {}) };

  const version = await db.$transaction(async (tx) => {
    if (!currentDomain) {
      await tx.domain.create({ data: { slug: domainSlug, name: domainData.name, version: 1, data: json(domainData), orgId: org.id } });
    }
    if (!currentAgent) {
      await tx.agent.create({
        data: { slug, name: agentData.name, version: 1, domainSlug, personaId: persona.id, data: json(data), orgId: org.id },
      });
      return 1;
    }
    if (JSON.stringify(currentAgent.data) === JSON.stringify(data) && currentAgent.personaId === persona.id) {
      return currentAgent.version;
    }
    // Same versioning as a dashboard publish: snapshot the old spec, bump the version.
    const { version: previous } = currentAgent;
    await tx.specVersion.create({
      data: { entityType: "agents", entitySlug: slug, version: previous, data: json(currentAgent.data), orgId: org.id },
    });
    await tx.agent.update({
      where: { id: currentAgent.id },
      data: { name: agentData.name, version: previous + 1, domainSlug, personaId: persona.id, data: json(data) },
    });
    return previous + 1;
  });

  return { slug, name: agentData.name, version, created: !currentAgent, items: itemCount };
}

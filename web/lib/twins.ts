import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { validSlug } from "@/lib/specs";

/**
 * A twin ("Ask Olga") is an open conversation with a trainer's persona that can draw on every
 * playbook (scenario-ingest scenario) of that persona. It is a normal Agent row with
 * `data.source = "twin"`, so sessions, invites, deployments and usage work unchanged.
 * Its playbooks are not copied: they are the persona's ingested scenarios, found at session start.
 */

export const TWIN_SOURCE = "twin";

export type TwinPlaybook = {
  /** Agent slug of the scenario (what scenario items are stored under). */
  slug: string;
  /** scenario.json `scenario` id, used as the skill name. */
  id: string;
  name: string;
  description: string;
  trainerRole?: string;
  learnerRole?: string;
  steps: { id: string; name: string; trainer_moves?: unknown; learner_moves?: unknown }[];
  /** SKILL.md as ingested. */
  skill: string;
};

const asRecord = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** Every skill twin of this persona (an ingested SKILL.md), as the all-skills twin's playbooks. */
export async function twinPlaybooks(orgId: string, personaId: string): Promise<TwinPlaybook[]> {
  const rows = await db.agent.findMany({
    where: { orgId, personaId, kind: "TWIN" },
    orderBy: [{ order: "asc" }, { name: "asc" }],
    select: { slug: true, name: true, data: true },
  });
  return rows.flatMap((row) => {
    const data = asRecord(row.data);
    const manifest = asRecord(data?.scenario);
    // The all-skills twin itself has no skill; only skill twins carry one.
    if (typeof data?.skill !== "string" || !manifest) return [];
    return [{
      slug: row.slug,
      id: typeof manifest.scenario === "string" ? manifest.scenario : row.slug,
      name: typeof manifest.name === "string" ? manifest.name : row.name,
      description: typeof manifest.description === "string" ? manifest.description : "",
      trainerRole: typeof manifest.trainer_role === "string" ? manifest.trainer_role : undefined,
      learnerRole: typeof manifest.learner_role === "string" ? manifest.learner_role : undefined,
      steps: Array.isArray(manifest.steps) ? (manifest.steps as TwinPlaybook["steps"]) : [],
      skill: data.skill,
    }];
  });
}

/** Creates the persona's twin if it does not exist yet. Safe to call again. */
export async function ensureTwin(orgId: string, personaSlug: string) {
  const [org, persona] = await Promise.all([
    db.organization.findUnique({ where: { id: orgId }, select: { slug: true } }),
    // A twin is the user's own persona, never a global or invented one (also enforced by a DB trigger).
    db.persona.findFirst({ where: { orgId, isOwn: true, slug: { equals: personaSlug, mode: "insensitive" } }, select: { id: true, slug: true, name: true } }),
  ]);
  if (!org) throw new TwinError("Organization not found", 404);
  if (!persona) throw new TwinError(`Persona "${personaSlug}" was not found in this organization`, 404);

  const slug = `${org.slug}-${persona.slug}-twin`.toLowerCase();
  const domainSlug = `domain-${slug}`;
  if (!validSlug(slug)) throw new TwinError(`"${slug}" is not a valid twin id`, 400);

  const [existing, existingDomain] = await Promise.all([
    db.agent.findUnique({ where: { slug }, select: { orgId: true, name: true } }),
    db.domain.findUnique({ where: { slug: domainSlug }, select: { orgId: true } }),
  ]);
  if ((existing && existing.orgId !== orgId) || (existingDomain && existingDomain.orgId !== orgId)) {
    throw new TwinError(`Twin "${slug}" belongs to another organization`, 409);
  }
  if (existing) return { slug, name: existing.name, created: false };

  const name = `${persona.name}'s twin`;
  const data = {
    id: slug,
    name,
    objective: `Helps with real client situations: what to do and say next, the way ${persona.name} would.`,
    domain: domainSlug,
    source: TWIN_SOURCE,
    config: { context: { mode: "none", required: false } },
  };
  const json = (value: unknown) => value as Prisma.InputJsonValue;
  await db.$transaction(async (tx) => {
    if (!existingDomain) {
      await tx.domain.create({ data: { slug: domainSlug, name, version: 1, data: json({ id: domainSlug, name }), orgId } });
    }
    await tx.agent.create({ data: { slug, name, version: 1, domainSlug, personaId: persona.id, kind: "TWIN", data: json(data), orgId } });
  });
  return { slug, name, created: true };
}

export class TwinError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

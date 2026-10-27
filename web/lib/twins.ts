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

/** A skill twin's spec as a playbook, or null when it carries no skill (the all-skills twin itself). */
function toPlaybook(slug: string, name: string, agentData: unknown): TwinPlaybook | null {
  const data = asRecord(agentData);
  const manifest = asRecord(data?.scenario);
  if (typeof data?.skill !== "string" || !manifest) return null;
  return {
    slug,
    // scenario.json names it `scenario`; a twin-creator skill.json names it `skill` and lists situations, not steps.
    id: typeof manifest.scenario === "string" ? manifest.scenario : typeof manifest.skill === "string" ? manifest.skill : slug,
    name: typeof manifest.name === "string" ? manifest.name : name,
    description: typeof manifest.description === "string" ? manifest.description : "",
    trainerRole: typeof manifest.trainer_role === "string" ? manifest.trainer_role : undefined,
    learnerRole: typeof manifest.learner_role === "string" ? manifest.learner_role : undefined,
    steps: Array.isArray(manifest.steps) ? (manifest.steps as TwinPlaybook["steps"]) : Array.isArray(manifest.situations) ? (manifest.situations as TwinPlaybook["steps"]) : [],
    skill: data.skill,
  };
}

/** The skill twins (and their versions) an all-skills twin session is pinned to, saved when it starts. */
export type PinnedTwinSkill = { slug: string; version: number };

const liveSkillTwins = (orgId: string, personaId: string) =>
  db.agent.findMany({
    where: { orgId, personaId, kind: "TWIN" },
    orderBy: [{ order: "asc" }, { name: "asc" }],
    select: { slug: true, name: true, version: true, data: true },
  });

/** The persona's skill twins right now, to pin into a new session's snapshot. */
export async function pinTwinSkills(orgId: string, personaId: string): Promise<PinnedTwinSkill[]> {
  const rows = await liveSkillTwins(orgId, personaId);
  return rows.filter((row) => toPlaybook(row.slug, row.name, row.data)).map(({ slug, version }) => ({ slug, version }));
}

/**
 * The all-skills twin's playbooks. With `pinned` (a session's snapshot) the session keeps exactly the skills and
 * versions it started with: a skill re-ingested since then is read from its SpecVersion, one ingested since then
 * is left out, one deleted since then is dropped. Without `pinned`, every skill twin of the persona right now.
 */
export async function twinPlaybooks(orgId: string, personaId: string, pinned?: PinnedTwinSkill[]): Promise<TwinPlaybook[]> {
  const rows = await liveSkillTwins(orgId, personaId);
  if (!pinned) return rows.flatMap((row) => toPlaybook(row.slug, row.name, row.data) ?? []);

  const live = new Map(rows.map((row) => [row.slug, row]));
  const older = pinned.filter(({ slug, version }) => live.get(slug)?.version !== version);
  const versions = older.length
    ? await db.specVersion.findMany({
        where: { orgId, entityType: "agents", OR: older.map(({ slug, version }) => ({ entitySlug: slug, version })) },
        select: { entitySlug: true, version: true, data: true },
      })
    : [];
  const snapshotOf = new Map(versions.map((row) => [`${row.entitySlug}@${row.version}`, row.data]));
  return pinned.flatMap(({ slug, version }) => {
    const row = live.get(slug);
    const data = row?.version === version ? row.data : snapshotOf.get(`${slug}@${version}`);
    return toPlaybook(slug, row?.name ?? slug, data) ?? [];
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
  if (!validSlug(slug)) throw new TwinError(`"${slug}" is not a valid twin id`, 400);

  const existing = await db.agent.findUnique({ where: { slug }, select: { orgId: true, name: true } });
  if (existing && existing.orgId !== orgId) {
    throw new TwinError(`Twin "${slug}" belongs to another organization`, 409);
  }
  if (existing) return { slug, name: existing.name, created: false };

  const name = `${persona.name}'s twin`;
  const data = {
    id: slug,
    name,
    objective: `Helps with real client situations: what to do and say next, the way ${persona.name} would.`,
    source: TWIN_SOURCE,
    config: { context: { mode: "none", required: false } },
  };
  const json = (value: unknown) => value as Prisma.InputJsonValue;
  await db.agent.create({ data: { slug, name, version: 1, personaId: persona.id, kind: "TWIN", data: json(data), orgId } });
  return { slug, name, created: true };
}

export class TwinError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

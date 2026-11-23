import { db, withLock } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { validSlug } from "@/lib/specs";
import { resolveSnapshotSkill, type SessionSkillCatalogEntry, type loadSessionSkills } from "@/lib/session-skills";
import { hydrateAgentSkill } from "@/lib/skill-history";
import { supportingCatalog } from "@/lib/agent-skills";

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
  /** The version this playbook is (live, or pinned by the call): its scenario items are searched at this version. */
  version: number;
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
function toPlaybook(slug: string, name: string, agentData: unknown, version: number): TwinPlaybook | null {
  const data = asRecord(agentData);
  const manifest = asRecord(data?.scenario);
  if (typeof data?.skill !== "string" || !manifest) return null;
  return {
    slug,
    version,
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
export type PinnedTwinSkill = SessionSkillCatalogEntry;

const liveSkillTwins = async (orgId: string, personaId: string) => {
  const rows = await db.agent.findMany({
    where: { orgId, personaId, kind: "TWIN", archivedAt: null },
    orderBy: [{ order: "asc" }, { name: "asc" }],
    select: { id: true, slug: true, name: true, primarySkillId: true, version: true, data: true },
  });
  return Promise.all(rows.map((row) => row.primarySkillId ? hydrateAgentSkill(orgId, row) : row));
};

/** The persona's skill twins right now, to pin into a new session's snapshot. */
export async function pinTwinSkills(orgId: string, personaId: string): Promise<PinnedTwinSkill[]> {
  const rows = await liveSkillTwins(orgId, personaId);
  return rows.filter((row) => toPlaybook(row.slug, row.name, row.data, row.version)).map(({ slug, version }) => ({ slug, version }));
}

/**
 * The skills a main twin session pins: its supporting skills (lib/agent-skills) once it has any, else (not merged yet)
 * every skill twin of its persona.
 */
export async function resolveTwinCatalog(orgId: string, personaId: string, client: Prisma.TransactionClient, agentId?: string) {
  const supporting = agentId ? await supportingCatalog(orgId, agentId, client) : null;
  if (supporting) return supporting;
  await client.$queryRaw`SELECT 1 FROM "Agent" WHERE "orgId" = ${orgId} AND "personaId" = ${personaId} AND "kind" = 'TWIN' AND "archivedAt" IS NULL FOR KEY SHARE`;
  const rows = await client.agent.findMany({
    where: { orgId, personaId, kind: "TWIN", archivedAt: null },
    orderBy: [{ order: "asc" }, { name: "asc" }],
    select: { id: true, slug: true, name: true, version: true, data: true, primarySkillId: true },
  });
  const catalog: PinnedTwinSkill[] = [];
  const pins: { skillVersionId: string; alias: string; position: number }[] = [];
  for (const row of rows) {
    if (asRecord(row.data)?.source === TWIN_SOURCE) continue;
    if (!row.primarySkillId && !toPlaybook(row.slug, row.name, row.data, row.version)) continue;
    const version = row.primarySkillId ? await resolveSnapshotSkill(orgId, row, "TWIN", client) : null;
    if (version) pins.push({ skillVersionId: version.id, alias: row.slug, position: catalog.length });
    catalog.push({ slug: row.slug, version: row.version, ...(version ? { skillVersionId: version.id } : {}) });
  }
  return { catalog, pins };
}

export async function sessionTwinPlaybooks(orgId: string, runtime: NonNullable<Awaited<ReturnType<typeof loadSessionSkills>>>) {
  const legacyEntries = runtime.catalog.filter((entry) => !entry.skillVersionId);
  const legacy = legacyEntries.length ? await twinPlaybooks(orgId, runtime.personaId, legacyEntries) : [];
  const legacyBySlug = new Map(legacy.map((playbook) => [playbook.slug, playbook]));
  const managedBySlug = new Map(runtime.pins.map((pin) => [pin.alias, pin.version]));
  return runtime.catalog.flatMap((entry) => {
    const version = managedBySlug.get(entry.slug);
    return (version
      ? toPlaybook(entry.slug, entry.slug, { skill: version.skillText, scenario: version.manifest }, entry.version)
      : legacyBySlug.get(entry.slug)) ?? [];
  });
}

/**
 * The all-skills twin's playbooks. With `pinned` (a session's snapshot) the session keeps exactly the skills and
 * versions it started with: a skill re-ingested since then is read from its SpecVersion, one ingested since then
 * is left out, one deleted since then is dropped. Without `pinned`, every skill twin of the persona right now.
 */
export async function twinPlaybooks(orgId: string, personaId: string, pinned?: PinnedTwinSkill[]): Promise<TwinPlaybook[]> {
  const rows = pinned
    ? await db.agent.findMany({
        where: { orgId, personaId, kind: "TWIN", slug: { in: pinned.map((entry) => entry.slug) } },
        select: { id: true, slug: true, name: true, primarySkillId: true, version: true, data: true },
      })
    : await liveSkillTwins(orgId, personaId);
  if (!pinned) return rows.flatMap((row) => toPlaybook(row.slug, row.name, row.data, row.version) ?? []);

  const live = new Map(rows.map((row) => [row.slug, row]));
  const older = pinned.filter(({ slug, version }) => live.get(slug)?.version !== version);
  const versions = older.length
    ? await db.specVersion.findMany({
        where: { orgId, entityType: "agents", OR: older.map(({ slug, version }) => ({ entitySlug: slug, version })) },
        select: { entitySlug: true, version: true, data: true },
      })
    : [];
  const snapshotOf = new Map(versions.map((row) => [`${row.entitySlug}@${row.version}`, row.data]));
  const playbooks = await Promise.all(pinned.map(async ({ slug, version }) => {
    const row = live.get(slug);
    const data = row?.version === version ? row.data : snapshotOf.get(`${slug}@${version}`);
    const hydrated = row?.primarySkillId
      ? await hydrateAgentSkill(orgId, { ...row, version, data })
      : { data };
    return toPlaybook(slug, row?.name ?? slug, hydrated.data, version);
  }));
  return playbooks.flatMap((playbook) => playbook ?? []);
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

  return withLock([`agent:${slug}`], async (tx) => {
    const existing = await tx.agent.findUnique({ where: { slug }, select: { orgId: true, name: true, kind: true, personaId: true, data: true, archivedAt: true } });
    if (existing) {
      if (existing.orgId !== orgId || existing.kind !== "TWIN" || existing.personaId !== persona.id || asRecord(existing.data)?.source !== TWIN_SOURCE || existing.archivedAt) {
        throw new TwinError("That twin name is already in use or archived", 409);
      }
      return { slug, name: existing.name, created: false };
    }

    const name = `${persona.name}'s twin`;
    const data = {
      id: slug,
      name,
      objective: `Helps with real client situations: what to do and say next, the way ${persona.name} would.`,
      source: TWIN_SOURCE,
      config: { context: { mode: "none", required: false } },
    };
    await tx.agent.create({ data: { slug, name, version: 1, personaId: persona.id, kind: "TWIN", data, orgId } });
    return { slug, name, created: true };
  });
}

export class TwinError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

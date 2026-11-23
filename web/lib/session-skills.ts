import { db } from "@/lib/db";
import { refusals } from "@/lib/errors";
import type { Prisma } from "@/lib/generated/prisma/client";
import { skillRefusals } from "@/lib/skills";
import { runsAsMainTwin } from "@/lib/main-twin";

const runtimeVersionSelect = {
  id: true,
  version: true,
  skillId: true,
  status: true,
  indexStatus: true,
  format: true,
  skillText: true,
  manifest: true,
  artifacts: true,
  itemCount: true,
  skill: { select: { orgId: true, ownerSlug: true } },
} satisfies Prisma.SkillVersionSelect;

export type ManagedRoleplayRuntimeVersion = Prisma.SkillVersionGetPayload<{ select: typeof runtimeVersionSelect }>;
export type SessionSkillCatalogEntry = { slug: string; version: number; skillVersionId?: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function validateVersion(version: ManagedRoleplayRuntimeVersion, kind: string) {
  if (version.status !== "ready" || version.indexStatus !== "ready"
    || !(kind === "ROLEPLAY" ? ["builder-roleplay", "authored-roleplay"] : ["twin", "legacy-twin"]).includes(version.format)
    || typeof version.skillText !== "string" || !version.skillText.trim()
    || !version.manifest || typeof version.manifest !== "object" || Array.isArray(version.manifest)
    || typeof version.artifacts !== "string" || !version.artifacts
    || !Number.isSafeInteger(version.itemCount) || version.itemCount < 0) throw skillRefusals.unavailable();
  return version;
}

export async function resolveRoleplaySnapshotSkill(
  orgId: string,
  agent: { id?: string; version?: number; slug: string; primarySkillId: string | null; data: unknown },
  client: Prisma.TransactionClient = db,
) {
  return resolveSnapshotSkill(orgId, agent, "ROLEPLAY", client);
}

export async function resolveSnapshotSkill(
  orgId: string,
  agent: { id?: string; version?: number; slug: string; primarySkillId: string | null; data: unknown },
  kind: "ROLEPLAY" | "TWIN",
  client: Prisma.TransactionClient = db,
) {
  if (agent.id && agent.version !== undefined) {
    const mapping = await client.agentSkillVersion.findUnique({
      where: { agentId_agentVersion: { agentId: agent.id, agentVersion: agent.version } },
      select: { orgId: true, version: { select: runtimeVersionSelect } },
    });
    if (mapping) {
      const version = mapping.version;
      if (mapping.orgId !== orgId || version.skill.orgId !== orgId || version.skill.ownerSlug !== agent.slug
        || (agent.primarySkillId && version.skillId !== agent.primarySkillId)) throw skillRefusals.unavailable();
      return validateVersion(version, kind);
    }
  }
  const artifacts = record(agent.data).artifacts;
  if (!agent.primarySkillId || typeof artifacts !== "string" || !artifacts) throw skillRefusals.unavailable();
  const versions = await client.skillVersion.findMany({
    select: runtimeVersionSelect,
    where: {
      skillId: agent.primarySkillId,
      artifacts,
      skill: { orgId, ownerSlug: agent.slug },
      status: "ready",
      format: { in: kind === "ROLEPLAY" ? ["builder-roleplay", "authored-roleplay"] : ["twin", "legacy-twin"] },
    },
  });
  if (versions.length !== 1) throw skillRefusals.unavailable();
  return validateVersion(versions[0], kind);
}

export async function loadSessionSkills(orgId: string, sessionId: string, agentSlug?: string, allowCatalogAlias = false) {
  const session = await db.interviewSession.findFirst({
    where: { id: sessionId, orgId },
    select: {
      agentSlug: true,
      skillPinsVersion: true,
      compiledSnapshot: true,
      skillPins: { select: {
        orgId: true,
        alias: true,
        position: true,
        version: { select: runtimeVersionSelect },
      }, orderBy: { position: "asc" } },
    },
  });
  if (!session) throw refusals.notFound();
  const snapshotAgent = record(record(session.compiledSnapshot).agent);
  const data = record(snapshotAgent.data);
  const kind = snapshotAgent.kind;
  const isMainTwin = runsAsMainTwin(String(kind), data);
  const rawCatalog = record(session.compiledSnapshot).twinSkills;
  const catalog: SessionSkillCatalogEntry[] = [];
  if (Array.isArray(rawCatalog)) {
    for (const value of rawCatalog) {
      const entry = record(value);
      if (typeof entry.slug !== "string" || !Number.isSafeInteger(entry.version) || Number(entry.version) < 1
        || (entry.skillVersionId !== undefined && typeof entry.skillVersionId !== "string")) throw skillRefusals.unavailable();
      catalog.push({ slug: entry.slug, version: Number(entry.version), ...(typeof entry.skillVersionId === "string" ? { skillVersionId: entry.skillVersionId } : {}) });
    }
  }
  if (agentSlug && agentSlug !== session.agentSlug
    && !(allowCatalogAlias && isMainTwin && catalog.some((entry) => entry.slug === agentSlug))) throw refusals.notFound();
  if (session.skillPinsVersion === null) return null;
  if (session.skillPinsVersion !== 1 || !["ROLEPLAY", "TWIN", "BOT"].includes(String(kind))
    || (isMainTwin && !Array.isArray(rawCatalog))
    || (!isMainTwin && session.skillPins.length !== 1)
    || new Set(catalog.map((entry) => entry.slug)).size !== catalog.length) throw skillRefusals.unavailable();
  const pins = session.skillPins.map((pin) => {
    const version = validateVersion(pin.version, String(kind));
    const entry = isMainTwin ? catalog[pin.position] : undefined;
    if (pin.orgId !== orgId || version.skill.orgId !== orgId || version.skill.ownerSlug !== pin.alias
      || (isMainTwin
        ? !entry || entry.slug !== pin.alias || entry.skillVersionId !== version.id
        : pin.alias !== session.agentSlug || pin.position !== 0
          || snapshotAgent.primarySkillId !== version.skillId || data.artifacts !== version.artifacts)) throw skillRefusals.unavailable();
    return { alias: pin.alias, position: pin.position, version };
  });
  if (isMainTwin && catalog.filter((entry) => entry.skillVersionId !== undefined).length !== pins.length) throw skillRefusals.unavailable();
  const version = pins[0]?.version;
  return {
    kind: kind as "ROLEPLAY" | "TWIN" | "BOT",
    agentSlug: session.agentSlug,
    personaId: String(record(record(session.compiledSnapshot).persona).id ?? ""),
    isMainTwin,
    pins,
    catalog: isMainTwin ? catalog : [{ slug: session.agentSlug, version: Number(snapshotAgent.version), skillVersionId: version.id }],
    data: isMainTwin ? data : { ...data, skill: version.skillText, scenario: version.manifest, artifacts: version.artifacts },
  };
}

export async function loadRoleplaySessionSkill(orgId: string, sessionId: string, agentSlug?: string) {
  const loaded = await loadSessionSkills(orgId, sessionId, agentSlug);
  if (!loaded || loaded.kind !== "ROLEPLAY") return null;
  return { version: loaded.pins[0].version, data: loaded.data };
}

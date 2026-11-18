import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { skillRefusals, verifySkillEnvelope } from "@/lib/skills";

type HistoryClient = Pick<Prisma.TransactionClient, "agentSkillVersion" | "skillVersion">;
const historyVersionSelect = {
  id: true, skillId: true, version: true, status: true, indexStatus: true, format: true,
  skillText: true, manifest: true, artifacts: true, itemCount: true, contentHash: true,
  skill: { select: { orgId: true, ownerSlug: true } },
} satisfies Prisma.SkillVersionSelect;

export type AgentSkillVersionProjection = Prisma.SkillVersionGetPayload<{ select: typeof historyVersionSelect }>;

export async function readAgentSkillVersion(orgId: string, agentId: string, agentVersion: number, client: HistoryClient = db) {
  const mapping = await client.agentSkillVersion.findFirst({
    where: { orgId, agentId, agentVersion, agent: { orgId } },
    include: { agent: { select: { slug: true } }, version: { select: historyVersionSelect } },
  });
  if (!mapping) return null;
  const version = mapping.version;
  if (version.skill.orgId !== orgId || version.skill.ownerSlug !== mapping.agent.slug || version.status !== "ready") {
    throw skillRefusals.unavailable();
  }
  return version;
}

export async function getMappedSkillPackage(
  orgId: string,
  agentId: string,
  agentVersion: number,
  client: HistoryClient = db,
  options: { verifyFiles?: boolean } = {},
) {
  const version = await readAgentSkillVersion(orgId, agentId, agentVersion, client);
  if (!version) return null;
  if (!options.verifyFiles) return { version, files: undefined };
  const fullVersion = await client.skillVersion.findFirst({
    where: { id: version.id, status: "ready", skill: { orgId, ownerSlug: version.skill.ownerSlug } },
  });
  if (!fullVersion) throw skillRefusals.unavailable();
  return { version, files: verifySkillEnvelope(fullVersion) };
}

export async function carryAgentSkillVersion(orgId: string, agentId: string, fromVersion: number, toVersion: number, client: HistoryClient) {
  const version = await readAgentSkillVersion(orgId, agentId, fromVersion, client);
  if (!version) return;
  await client.agentSkillVersion.createMany({
    data: [{ orgId, agentId, agentVersion: toVersion, skillVersionId: version.id }],
    skipDuplicates: true,
  });
  const carried = await readAgentSkillVersion(orgId, agentId, toVersion, client);
  if (carried?.id !== version.id) throw skillRefusals.unavailable();
}

type HydratableAgent = {
  id: string;
  slug: string;
  version: number;
  primarySkillId?: string | null;
  orgId?: string | null;
  data: unknown;
};

export async function hydrateAgentSkill<A extends HydratableAgent>(orgId: string, agent: A, client: HistoryClient = db) {
  if (agent.orgId !== undefined && agent.orgId !== orgId) throw skillRefusals.unavailable();
  const data = agent.data && typeof agent.data === "object" && !Array.isArray(agent.data)
    ? agent.data as Record<string, unknown> : {};
  const version = await readAgentSkillVersion(orgId, agent.id, agent.version, client);
  if (!version && agent.primarySkillId) {
    const compatibility = typeof data.artifacts === "string"
      ? await client.skillVersion.findMany({
        where: { skillId: agent.primarySkillId, artifacts: data.artifacts, status: "ready", skill: { orgId, ownerSlug: agent.slug } },
        select: historyVersionSelect,
      })
      : [];
    if (compatibility.length !== 1) throw skillRefusals.unavailable();
    const saved = compatibility[0];
    // Phase 4 compatibility is anchored to saved artifacts, never the moving current pointer.
    return {
      ...agent,
      data: { ...data, skill: saved.skillText, scenario: saved.manifest, artifacts: saved.artifacts, filesHash: saved.contentHash },
    };
  }
  if (!version) return agent;
  return {
    ...agent,
    data: { ...data, skill: version.skillText, scenario: version.manifest, artifacts: version.artifacts, filesHash: version.contentHash },
  };
}

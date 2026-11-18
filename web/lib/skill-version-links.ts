import type { Prisma } from "@/lib/generated/prisma/client";
import { countSources, skillSourceRows } from "@/lib/skill-sources";
import { skillRefusals, verifySkillEnvelope } from "@/lib/skills";

type Link = { orgId: string; agentId: string; agentVersion: number; skillVersionId: string };

export async function ensureAgentSkillVersion(tx: Prisma.TransactionClient, input: Link) {
  const where = { agentId_agentVersion: { agentId: input.agentId, agentVersion: input.agentVersion } };
  const existing = await tx.agentSkillVersion.findUnique({ where });
  if (existing) {
    if (existing.orgId !== input.orgId || existing.skillVersionId !== input.skillVersionId) throw skillRefusals.unavailable();
    return;
  }
  await tx.agentSkillVersion.createMany({ data: [input], skipDuplicates: true });
  const mapping = await tx.agentSkillVersion.findUniqueOrThrow({ where });
  if (mapping.orgId !== input.orgId || mapping.skillVersionId !== input.skillVersionId) throw skillRefusals.unavailable();
}

export async function recordPublicationSkillLinks(tx: Prisma.TransactionClient, input: Link, items: unknown[]) {
  await ensureAgentSkillVersion(tx, input);
  const counts = countSources(items);
  const existing = await tx.skillVersionSource.findMany({ where: { skillVersionId: input.skillVersionId } });
  const legacy = await tx.skillSource.findMany({
    where: { agentId: input.agentId, version: input.agentVersion, orgId: input.orgId },
  });
  for (const row of [...existing, ...legacy]) {
    if (row.orgId !== input.orgId || counts.get(row.documentId) !== row.items) throw skillRefusals.unavailable();
  }
  const rows = await skillSourceRows(input.orgId, input.agentId, input.agentVersion, items, tx);
  const sources = new Map([...rows, ...legacy, ...existing].map((row) => [row.documentId, row]));
  await tx.skillSource.createMany({
    data: [...sources.values()].map(({ documentId, title, items }) => ({
      agentId: input.agentId, version: input.agentVersion, orgId: input.orgId, documentId, title, items,
    })),
    skipDuplicates: true,
  });
  await tx.skillVersionSource.createMany({
    data: [...sources.values()].map(({ documentId, title, items }) => ({
      skillVersionId: input.skillVersionId, orgId: input.orgId, documentId, title, items,
    })),
    skipDuplicates: true,
  });
  const saved = await tx.skillVersionSource.findMany({ where: { skillVersionId: input.skillVersionId } });
  for (const row of saved) {
    if (row.orgId !== input.orgId || counts.get(row.documentId) !== row.items) throw skillRefusals.unavailable();
  }
}

export async function preserveAgentSkillVersion(
  tx: Prisma.TransactionClient,
  agent: { id: string; slug: string; orgId: string | null; version: number; primarySkillId: string | null; data: Prisma.JsonValue },
) {
  const mapping = await tx.agentSkillVersion.findUnique({
    where: { agentId_agentVersion: { agentId: agent.id, agentVersion: agent.version } },
  });
  if (mapping) {
    const version = await tx.skillVersion.findUniqueOrThrow({ where: { id: mapping.skillVersionId } });
    const skill = await tx.skill.findUniqueOrThrow({ where: { id: version.skillId } });
    if (mapping.orgId !== agent.orgId || skill.orgId !== agent.orgId || skill.ownerSlug !== agent.slug
      || version.status !== "ready" || (agent.primarySkillId && version.skillId !== agent.primarySkillId)) throw skillRefusals.unavailable();
    const items: unknown = JSON.parse(verifySkillEnvelope(version)["items.json"]);
    if (!Array.isArray(items)) throw skillRefusals.unavailable();
    await recordPublicationSkillLinks(tx, {
      orgId: mapping.orgId, agentId: agent.id, agentVersion: agent.version, skillVersionId: version.id,
    }, items);
    return;
  }
  if (!agent.orgId || !agent.primarySkillId) return;
  const data = agent.data;
  const artifacts = data && typeof data === "object" && !Array.isArray(data) ? data.artifacts : null;
  if (typeof artifacts !== "string" || !artifacts) throw skillRefusals.unavailable();
  const versions = await tx.skillVersion.findMany({
    where: { skillId: agent.primarySkillId, artifacts, status: "ready", skill: { orgId: agent.orgId, ownerSlug: agent.slug } },
  });
  if (versions.length !== 1) throw skillRefusals.unavailable();
  const version = versions[0];
  const items: unknown = JSON.parse(verifySkillEnvelope(version)["items.json"]);
  if (!Array.isArray(items)) throw skillRefusals.unavailable();
  await recordPublicationSkillLinks(tx, {
    orgId: agent.orgId, agentId: agent.id, agentVersion: agent.version, skillVersionId: version.id,
  }, items);
}

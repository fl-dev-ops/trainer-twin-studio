import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { AppError, refusals } from "@/lib/errors";
import type { Prisma } from "@/lib/generated/prisma/client";
import { orgPrefix, putObject, getObjectText } from "@/lib/s3";
import { stableJson } from "@/lib/stable-json";

export type SkillFormat = "twin" | "legacy-twin" | "builder-roleplay" | "authored-roleplay";
export type SkillFiles = Record<string, string>;
type Tx = Prisma.TransactionClient;

export const skillRefusals = {
  superseded: () => new AppError("skill_publication_superseded", "This publication was superseded. Retry with the latest saved settings.", 409),
  unavailable: () => new AppError("skill_package_unavailable", "This skill package is not available.", 503),
};

export function skillPackageHash(format: SkillFormat, files: SkillFiles) {
  return createHash("sha256").update(JSON.stringify([format, Object.keys(files).sort().map((name) => [name, files[name]])])).digest("hex");
}

export function skillFiles(value: Prisma.JsonValue): SkillFiles {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw skillRefusals.unavailable();
  const files: SkillFiles = {};
  for (const [name, bytes] of Object.entries(value)) {
    if (typeof bytes !== "string" || !/^(SKILL\.md|skill\.json|scenario\.json|items\.json|patterns\.md)$/.test(name)) {
      throw skillRefusals.unavailable();
    }
    files[name] = bytes;
  }
  if (!files["SKILL.md"] || !files["items.json"] || !(files["skill.json"] || files["scenario.json"])) throw skillRefusals.unavailable();
  return files;
}

export function verifySkillEnvelope(input: { format: string; contentHash: string; files: Prisma.JsonValue; skillText: string; manifest: Prisma.JsonValue; itemCount: number }) {
  if (!["twin", "legacy-twin", "builder-roleplay", "authored-roleplay"].includes(input.format)) throw skillRefusals.unavailable();
  const files = skillFiles(input.files);
  const manifestName = input.format === "twin" ? "skill.json" : "scenario.json";
  try {
    const items: unknown = JSON.parse(files["items.json"]);
    const manifest: unknown = JSON.parse(files[manifestName]);
    if (files["SKILL.md"] !== input.skillText || stableJson(manifest) !== stableJson(input.manifest)
      || !Array.isArray(items) || items.length !== input.itemCount
      || skillPackageHash(input.format as SkillFormat, files) !== input.contentHash) throw skillRefusals.unavailable();
  } catch {
    throw skillRefusals.unavailable();
  }
  return files;
}

export async function reserveSkillVersion(tx: Tx, input: {
  orgId: string; slug: string; name: string; format: SkillFormat; skill: string;
  manifest: Prisma.InputJsonValue; files: SkillFiles; itemCount: number; agentVersion: number; unchanged: boolean; intentHash: string;
}) {
  const contentHash = skillPackageHash(input.format, input.files);
  const skill = await tx.skill.upsert({
    where: { orgId_ownerSlug: { orgId: input.orgId, ownerSlug: input.slug } },
    create: { orgId: input.orgId, ownerSlug: input.slug, name: input.name },
    update: { name: input.name },
  });
  const current = skill.currentVersionId
    ? await tx.skillVersion.findUniqueOrThrow({ where: { id: skill.currentVersionId } })
    : null;
  let version = current?.contentHash === contentHash ? current : await tx.skillVersion.findFirst({
    where: { skillId: skill.id, contentHash, status: { in: ["pending", "failed"] } },
    orderBy: { version: "desc" },
  });
  if (version?.status === "ready" && version.indexStatus !== "ready") throw skillRefusals.unavailable();
  const reuse = version?.status === "pending" && version.publicationGeneration === skill.generation && skill.generation > input.agentVersion && skill.publicationHash === input.intentHash
    || input.unchanged && current?.contentHash === contentHash && skill.generation <= input.agentVersion;
  const generation = reuse ? skill.generation : Math.max(skill.generation, input.agentVersion) + 1;
  await tx.skill.update({ where: { id: skill.id }, data: { generation, publicationHash: input.intentHash } });
  if (!version) {
    version = await tx.skillVersion.create({
      data: {
        skillId: skill.id, version: skill.nextVersion, format: input.format, contentHash, publicationGeneration: generation,
        skillText: input.skill, manifest: input.manifest, files: input.files, itemCount: input.itemCount,
        artifacts: `${orgPrefix(input.orgId)}/skills/${skill.id}/v${skill.nextVersion}`,
      },
    });
    await tx.skill.update({ where: { id: skill.id }, data: { nextVersion: { increment: 1 } } });
  } else if (version.status !== "ready") {
    version = await tx.skillVersion.update({ where: { id: version.id }, data: { status: "pending", indexStatus: "pending", failure: null, publicationGeneration: generation } });
  }
  return { skillId: skill.id, generation, version };
}

export async function uploadSkillFiles(version: { artifacts: string; files: Prisma.JsonValue }) {
  const files = skillFiles(version.files);
  await Promise.all(Object.entries(files).map(async ([name, bytes]) => {
    const key = `${version.artifacts}/${name}`;
    await putObject(key, bytes, name.endsWith(".json") ? "application/json" : "text/markdown; charset=utf-8");
    if (await getObjectText(key) !== bytes) throw skillRefusals.unavailable();
  }));
}

export async function activateSkillVersion(tx: Tx, input: { skillId: string; generation: number; versionId: string }) {
  const skill = await tx.skill.findUniqueOrThrow({ where: { id: input.skillId } });
  if (skill.generation !== input.generation) throw skillRefusals.superseded();
  const version = await tx.skillVersion.findUniqueOrThrow({ where: { id: input.versionId } });
  if (version.skillId !== skill.id || version.status !== "ready" && version.publicationGeneration !== input.generation) {
    throw skillRefusals.superseded();
  }
  await tx.skillVersion.update({
    where: { id: input.versionId }, data: { status: "ready", indexStatus: "ready", failure: null },
  });
  const activated = await tx.skill.updateMany({
    where: { id: input.skillId, generation: input.generation }, data: { currentVersionId: input.versionId },
  });
  if (activated.count !== 1) throw skillRefusals.superseded();
}

export async function failSkillVersion(versionId: string, error: unknown, client: Pick<Tx, "skillVersion"> = db) {
  await client.skillVersion.updateMany({
    where: { id: versionId, status: "pending" },
    data: {
      status: "failed", indexStatus: "failed",
      failure: error instanceof AppError ? `${error.code}: ${error.message}`.slice(0, 500)
        : "Skill publication failed before activation. Retry the original package; inspect server logs for provider details.",
    },
  });
}

export async function readSkillRegistry(orgId: string, agentSlug: string) {
  const skill = await db.skill.findUnique({
    where: { orgId_ownerSlug: { orgId, ownerSlug: agentSlug } },
    include: { versions: {
      orderBy: { version: "desc" }, take: 100,
      select: {
        id: true, version: true, format: true, status: true, indexStatus: true, contentHash: true,
        artifacts: true, itemCount: true, failure: true, createdAt: true, updatedAt: true,
      },
    } },
  });
  if (!skill) throw refusals.notFound();
  return skill;
}

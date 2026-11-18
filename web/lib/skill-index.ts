import { db, withLock } from "@/lib/db";
import { refusals } from "@/lib/errors";
import { MainCollectionService } from "@/lib/main-collection";
import { roleplayItemSchema } from "@/lib/roleplay/skill";
import { scenarioItemSchema } from "@/lib/scenario-ingest";
import { getObjectText } from "@/lib/s3";
import { skillRefusals, verifySkillEnvelope } from "@/lib/skills";

export async function rebuildSkillIndex(orgId: string, versionId: string) {
  const version = await db.skillVersion.findFirst({
    where: { id: versionId, skill: { orgId } }, include: { skill: { select: { ownerSlug: true } } },
  });
  if (!version) throw refusals.notFound();
  const claimed = await withLock([`agent:${version.skill.ownerSlug}`], async (tx) => {
    const current = await tx.skillVersion.findFirst({ where: { id: versionId, skill: { orgId } } });
    if (!current) throw refusals.notFound();
    if (current.status !== "ready") throw skillRefusals.unavailable();
    verifySkillEnvelope(current);
    return tx.skillVersion.update({
      where: { id: versionId },
      data: { indexGeneration: { increment: 1 }, indexStatus: "pending", failure: null },
    });
  });

  try {
    const files = verifySkillEnvelope(claimed);
    const stored = await Promise.all(Object.entries(files).map(async ([name, bytes]) => {
      const actual = await getObjectText(`${claimed.artifacts}/${name}`);
      if (actual !== bytes) throw skillRefusals.unavailable();
      return [name, actual] as const;
    }));
    const itemsBytes = stored.find(([name]) => name === "items.json")?.[1];
    if (!itemsBytes) throw skillRefusals.unavailable();
    const rawItems: unknown = JSON.parse(itemsBytes);
    const parsed = claimed.format === "builder-roleplay"
      ? roleplayItemSchema.array().safeParse(rawItems)
      : scenarioItemSchema.array().safeParse(rawItems);
    if (!parsed.success) throw skillRefusals.unavailable();
    const manifest = claimed.manifest;
    const scenarioId = manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ? manifest.skill ?? manifest.scenario : null;
    if (typeof scenarioId !== "string" || !scenarioId) throw skillRefusals.unavailable();
    const count = await MainCollectionService.writeSkillItems(orgId, versionId, scenarioId, parsed.data, claimed.artifacts);
    const saved = await db.skillVersion.updateMany({
      where: { id: versionId, indexGeneration: claimed.indexGeneration, status: "ready" },
      data: { indexStatus: "ready", failure: null },
    });
    if (saved.count !== 1) throw skillRefusals.indexSuperseded();
    return { versionId, items: count, indexGeneration: claimed.indexGeneration };
  } catch (error) {
    const failed = await db.skillVersion.updateMany({
      where: { id: versionId, indexGeneration: claimed.indexGeneration, status: "ready", indexStatus: "pending" },
      data: { indexStatus: "failed", failure: "Skill index rebuild failed. Verify the stored package and retry the rebuild." },
    });
    if (!failed.count) throw skillRefusals.indexSuperseded();
    throw error;
  }
}

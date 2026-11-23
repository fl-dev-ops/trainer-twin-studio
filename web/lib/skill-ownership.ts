import { db, withLock } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { SkillMigrationReport } from "@/lib/skill-migration";

export type SkillOwnership = {
  orgId: string;
  mode: "compatibility" | "managed";
  inventoryHash: string | null;
  verifiedAt: Date | null;
  approvedAt: Date | null;
  canaryReference: string | null;
  updatedAt: Date | null;
};

export const ownershipLock = (orgId: string) => `skill-ownership:${orgId}`;

export async function skillOwnership(orgId: string, client: Prisma.TransactionClient = db): Promise<SkillOwnership> {
  const rows = await client.$queryRaw<SkillOwnership[]>`
    SELECT * FROM "SkillOwnership" WHERE "orgId" = ${orgId}`;
  return rows[0] ?? {
    orgId, mode: "compatibility", inventoryHash: null, verifiedAt: null,
    approvedAt: null, canaryReference: null, updatedAt: null,
  };
}

export function packageFieldsOmitted<T extends object>(data: T): Omit<T, "skill" | "scenario" | "artifacts" | "filesHash"> {
  const { skill, scenario, artifacts, filesHash, ...settings } = {
    ...data, skill: undefined, scenario: undefined, artifacts: undefined, filesHash: undefined,
  };
  void skill; void scenario; void artifacts; void filesHash;
  return settings;
}

export class SkillOwnershipCoverageError extends Error {
  constructor(message: string, public readonly report: SkillMigrationReport) {
    super(message);
    this.name = "SkillOwnershipCoverageError";
  }
}

export async function activateSkillOwnership(orgId: string, options: {
  inventoryHash: string;
  canaryReference: string;
  apply: boolean;
}): Promise<SkillOwnership> {
  if (!options.apply) throw new Error("Skill ownership activation requires explicit apply approval.");
  if (!options.canaryReference.trim()) throw new Error("Supply a recorded live-canary attestation reference.");
  if (!options.inventoryHash.trim()) throw new Error("Supply the reviewed inventory hash.");
  return withLock([ownershipLock(orgId)], async (tx) => {
    await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { id: true } });
    // Deferred import keeps publisher -> ownership -> migration -> publisher acyclic at module initialization.
    const { checkSkillMigrationCoverage } = await import("@/lib/skill-migration");
    const report = await checkSkillMigrationCoverage(orgId);
    if (!report.complete || report.currentGaps.length || report.requiredGaps.length
      || report.historicalGaps.length || report.entries.some((entry) => entry.status !== "verified")) {
      throw new SkillOwnershipCoverageError("Skill ownership requires complete verified current and historical coverage.", report);
    }
    if (report.hash !== options.inventoryHash) {
      throw new SkillOwnershipCoverageError("Inventory hash is stale; review the fresh report before approving cutover.", report);
    }
    const existing = await skillOwnership(orgId, tx);
    if (existing.mode === "managed") return existing;
    const rows = await tx.$queryRaw<SkillOwnership[]>`
      INSERT INTO "SkillOwnership"
        ("orgId", mode, "inventoryHash", "verifiedAt", "approvedAt", "canaryReference", "updatedAt")
      VALUES (${orgId}, 'managed', ${report.hash}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
        ${options.canaryReference.trim()}, CURRENT_TIMESTAMP)
      ON CONFLICT ("orgId") DO UPDATE SET mode = 'managed',
        "inventoryHash" = EXCLUDED."inventoryHash", "verifiedAt" = EXCLUDED."verifiedAt",
        "approvedAt" = EXCLUDED."approvedAt", "canaryReference" = EXCLUDED."canaryReference",
        "updatedAt" = EXCLUDED."updatedAt"
      RETURNING *`;
    return rows[0];
  }, { timeout: 120_000, maxWait: 120_000 });
}

/** Managed ownership alone never proves old null-marker sessions or rollback readers are gone.
 * Index retirement requires a separate audited retention operation; this module never deletes indexes.
 */
export async function disableCompatibilityIndex(orgId: string): Promise<boolean> {
  if ((await skillOwnership(orgId)).mode !== "managed") {
    throw new Error("Compatibility indexing cannot be disabled before managed ownership.");
  }
  return false;
}

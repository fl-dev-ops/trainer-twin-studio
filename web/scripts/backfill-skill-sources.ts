/**
 * One-time upgrade, safe to re-run: records which knowledge base documents built each skill / role play's live version
 * (SkillSource), from that version's items.json in S3. Skips versions that already have rows. Runs in the production
 * build after the migrations (vercel.json), non-fatal.
 *
 *   bun --env-file=.env scripts/backfill-skill-sources.ts
 */
import { db, withLock } from "@/lib/db";
import { getObjectText, orgOwnKey } from "@/lib/s3";
import { skillSourceRows } from "@/lib/skill-sources";
import { ownershipLock, skillOwnership } from "@/lib/skill-ownership";

const agents = await db.agent.findMany({ select: { id: true, orgId: true, slug: true, version: true, data: true } });
let recorded = 0;
let failed = 0;
for (const agent of agents) {
  const orgId = agent.orgId;
  if (!orgId) continue;
  try {
    await withLock([ownershipLock(orgId), `agent:${agent.slug}`], async (tx) => {
      if ((await skillOwnership(orgId, tx)).mode === "managed") return;
      const current = await tx.agent.findFirst({ where: { id: agent.id, orgId } });
      const artifacts = (current?.data as { artifacts?: unknown } | null)?.artifacts;
      if (!current || typeof artifacts !== "string") return;
      if (!orgOwnKey(orgId, `${artifacts}/items.json`)) throw new Error("Published artifacts must belong to the organization");
      if (await tx.skillSource.count({ where: { agentId: current.id, version: current.version } })) return;
      const items: unknown = JSON.parse(await getObjectText(`${artifacts}/items.json`));
      if (!Array.isArray(items)) throw new Error("Published items.json must be an array");
      const rows = await skillSourceRows(orgId, current.id, current.version, items, tx);
      if (rows.length) await tx.skillSource.createMany({ data: rows, skipDuplicates: true });
      recorded += rows.length;
      console.log(`[backfill-skill-sources] ${current.slug} v${current.version}: ${rows.length} documents`);
    }, { timeout: 120_000, maxWait: 120_000 });
  } catch (error) {
    failed++;
    console.error(`[backfill-skill-sources] ${agent.slug} failed`, error);
  }
}
console.log(`[backfill-skill-sources] ${recorded} rows recorded, ${failed} failed`);
await db.$disconnect();
process.exit(failed ? 1 : 0);

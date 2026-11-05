/**
 * One-time upgrade, safe to re-run: records which knowledge base documents built each skill / role play's live version
 * (SkillSource), from that version's items.json in S3. Skips versions that already have rows. Runs in the production
 * build after the migrations (vercel.json), non-fatal.
 *
 *   bun --env-file=.env scripts/backfill-skill-sources.ts
 */
import { db } from "@/lib/db";
import { getObjectText } from "@/lib/s3";
import { skillSourceRows } from "@/lib/skill-sources";

const agents = await db.agent.findMany({ select: { id: true, orgId: true, slug: true, version: true, data: true } });
let recorded = 0;
let failed = 0;
for (const agent of agents) {
  const artifacts = (agent.data as { artifacts?: unknown } | null)?.artifacts;
  if (!agent.orgId || typeof artifacts !== "string") continue;
  if (await db.skillSource.count({ where: { agentId: agent.id, version: agent.version } })) continue;
  try {
    const items = JSON.parse((await getObjectText(`${artifacts}/items.json`)) || "[]") as unknown[];
    const rows = await skillSourceRows(agent.orgId, agent.id, agent.version, items);
    if (rows.length) await db.skillSource.createMany({ data: rows, skipDuplicates: true });
    recorded += rows.length;
    console.log(`[backfill-skill-sources] ${agent.slug} v${agent.version}: ${rows.length} documents`);
  } catch (error) {
    failed++;
    console.error(`[backfill-skill-sources] ${agent.slug} failed`, error);
  }
}
console.log(`[backfill-skill-sources] ${recorded} rows recorded, ${failed} failed`);
await db.$disconnect();
process.exit(failed ? 1 : 0);

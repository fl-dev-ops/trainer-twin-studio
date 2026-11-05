/**
 * One-time upgrade, safe to re-run: scenario items stored before versioning get `agentVersion` (their agent's current
 * version), so version-scoped searches find them. Runs in the production build after the migrations (vercel.json),
 * like a data migration; already tagged items are skipped, so later builds change nothing.
 *
 *   bun --env-file=.env scripts/backfill-scenario-item-versions.ts
 */
import { db } from "@/lib/db";
import { MainCollectionService } from "@/lib/main-collection";

const agents = await db.agent.findMany({ select: { orgId: true, slug: true, version: true, data: true } });
// Only skills and role plays published with files (artifacts) have scenario items.
const byOrg = new Map<string, Map<string, number>>();
for (const agent of agents) {
  if (!agent.orgId || typeof (agent.data as { artifacts?: unknown } | null)?.artifacts !== "string") continue;
  if (!byOrg.has(agent.orgId)) byOrg.set(agent.orgId, new Map());
  byOrg.get(agent.orgId)!.set(agent.slug, agent.version);
}

let failed = 0;
for (const [orgId, versionOf] of byOrg) {
  try {
    const tagged = await MainCollectionService.tagUnversionedScenarioItems(orgId, versionOf);
    console.log(`[backfill-scenario-item-versions] ${orgId}: ${versionOf.size} skills, ${tagged} items tagged`);
  } catch (error) {
    failed++;
    console.error(`[backfill-scenario-item-versions] ${orgId} failed`, error);
  }
}
await db.$disconnect();
process.exit(failed ? 1 : 0);

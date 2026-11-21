import { db } from "../lib/db";
import { checkSkillMigrationCoverage } from "../lib/skill-migration";
import { activateSkillOwnership, skillOwnership, SkillOwnershipCoverageError } from "../lib/skill-ownership";

const args = Bun.argv.slice(2);
const values = new Map<string, string>();
const switches = new Set<string>();
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (["--apply", "--dry-run", "--production"].includes(flag)) {
    if (switches.has(flag)) throw new Error(`Duplicate ${flag}`);
    switches.add(flag);
  } else if (["--org", "--inventory-hash", "--canary-reference"].includes(flag)) {
    const value = args[++i];
    if (!value || value.startsWith("--") || values.has(flag)) throw new Error(`Supply one value for ${flag}`);
    values.set(flag, value);
  } else throw new Error(`Unknown argument ${flag}`);
}
const orgSlug = values.get("--org");
if (!orgSlug) throw new Error("Usage: bun scripts/cutover-skills.ts --org <slug> [--dry-run | --apply --inventory-hash <hash> --canary-reference <attestation>] [--production]");
if (switches.has("--apply") && switches.has("--dry-run")) throw new Error("Choose either --apply or --dry-run.");
const inventoryHash = values.get("--inventory-hash");
const canaryReference = values.get("--canary-reference");
if (switches.has("--apply") && (!inventoryHash?.trim() || !canaryReference?.trim())) {
  throw new Error("--apply requires --inventory-hash and --canary-reference.");
}
const database = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) && !switches.has("--production")) {
  throw new Error("Remote database report/cutover requires --production.");
}
try {
  const org = await db.organization.findUniqueOrThrow({ where: { slug: orgSlug }, select: { id: true } });
  if (switches.has("--apply") && inventoryHash && canaryReference) {
    console.log(JSON.stringify(await activateSkillOwnership(org.id, { apply: true, inventoryHash, canaryReference }), null, 2));
  } else {
    const report = await checkSkillMigrationCoverage(org.id);
    console.log(JSON.stringify({
      ownership: await skillOwnership(org.id), report,
      compatibilityIndexRetention: "Retained; retirement requires a separate audited legacy-session and rollback-retention check.",
    }, null, 2));
    if (!report.complete || report.entries.some((entry) => entry.status !== "verified")
      || report.currentGaps.length || report.requiredGaps.length || report.historicalGaps.length) process.exitCode = 1;
  }
} catch (error) {
  if (!(error instanceof SkillOwnershipCoverageError)) throw error;
  console.error(JSON.stringify({ error: error.message, report: error.report }, null, 2));
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}

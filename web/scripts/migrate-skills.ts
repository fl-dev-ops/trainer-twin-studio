import { db } from "../lib/db";
import { migrateSkills } from "../lib/skill-migration";

const args = Bun.argv.slice(2);
const values = new Map<string, string>();
const switches = new Set<string>();
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (["--apply", "--check", "--dry-run", "--production"].includes(flag)) {
    if (switches.has(flag)) throw new Error(`Duplicate ${flag}`);
    switches.add(flag);
  } else if (["--org", "--batch-size", "--after"].includes(flag)) {
    const value = args[++i];
    if (!value || value.startsWith("--") || values.has(flag)) throw new Error(`Supply one value for ${flag}`);
    values.set(flag, value);
  } else throw new Error(`Unknown argument ${flag}`);
}
if (!values.get("--org")) throw new Error("Usage: bun scripts/migrate-skills.ts --org <slug> [--dry-run | --apply | --check] [--batch-size 50] [--after <cursor>] [--production]");
if (["--apply", "--check", "--dry-run"].filter((flag) => switches.has(flag)).length > 1) throw new Error("Choose one migration mode.");
const database = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) && !switches.has("--production")) {
  throw new Error("Remote database inventory/migration requires --production.");
}
try {
  const org = await db.organization.findUniqueOrThrow({ where: { slug: values.get("--org")! } });
  const report = await migrateSkills(org.id, {
    apply: switches.has("--apply"), check: switches.has("--check"),
    batchSize: values.has("--batch-size") ? Number(values.get("--batch-size")) : undefined,
    after: values.get("--after"),
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.entries.some((entry) => entry.status === "failed")
    || switches.has("--check") && (report.currentGaps.length || report.requiredGaps.length)) process.exitCode = 1;
} finally {
  await db.$disconnect();
}

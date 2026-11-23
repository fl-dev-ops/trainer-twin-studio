import { db } from "../lib/db";
import { rebuildSkillIndex } from "../lib/skill-index";

const args = Bun.argv.slice(2);
const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const orgSlug = value("--org");
const versionId = value("--version");
if (!orgSlug || orgSlug.startsWith("--") || !versionId || versionId.startsWith("--")) {
  throw new Error("Usage: bun scripts/reindex-skill.ts --org <slug> --version <skill-version-id> --apply [--production]");
}
if (!args.includes("--apply")) throw new Error("Reindexing changes Chroma and index state. Supply --apply explicitly.");
const database = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(database.hostname) && !args.includes("--production")) {
  throw new Error("Remote reindexing also requires --production.");
}

try {
  const org = await db.organization.findUniqueOrThrow({ where: { slug: orgSlug } });
  const result = await rebuildSkillIndex(org.id, versionId);
  console.log(JSON.stringify(result));
} finally {
  await db.$disconnect();
}

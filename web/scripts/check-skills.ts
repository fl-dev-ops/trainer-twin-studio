import { db } from "../lib/db";
import { MainCollectionService } from "../lib/main-collection";
import { getObjectText } from "../lib/s3";
import { verifySkillEnvelope } from "../lib/skills";

const orgSlug = Bun.argv[Bun.argv.indexOf("--org") + 1];
if (!Bun.argv.includes("--org") || !orgSlug || orgSlug.startsWith("--")) {
  throw new Error("Usage: bun scripts/check-skills.ts --org <slug> [--production]");
}
const database = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(database.hostname) && !Bun.argv.includes("--production")) {
  throw new Error("Remote inspection requires --production. This command does not change data.");
}

try {
  const org = await db.organization.findUniqueOrThrow({ where: { slug: orgSlug } });
  const skills = await db.skill.findMany({
    where: { orgId: org.id }, include: { versions: { orderBy: { version: "asc" } } }, orderBy: { ownerSlug: "asc" },
  });
  let failures = 0;
  for (const skill of skills) {
    for (const version of skill.versions) {
      try {
        if (version.status !== "ready") throw new Error(`publication ${version.status}: ${version.failure ?? "retry the original publication"}`);
        const files = verifySkillEnvelope(version);
        for (const [name, bytes] of Object.entries(files)) {
          if (await getObjectText(`${version.artifacts}/${name}`) !== bytes) throw new Error(`Stored file mismatch: ${name}`);
        }
        const count = await MainCollectionService.skillItemCount(org.id, version.id, version.artifacts);
        if (count !== version.itemCount) throw new Error(`Index count mismatch: ${count} != ${version.itemCount}`);
        console.log(`${skill.ownerSlug} package v${version.version}: verified (${count} items)${skill.currentVersionId === version.id ? " current" : ""}`);
      } catch (error) {
        failures++;
        console.error(`${skill.ownerSlug} package v${version.version}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  console.log(`${skills.length} skills inspected; ${failures} failed checks.`);
  if (failures) process.exitCode = 1;
} finally {
  await db.$disconnect();
}

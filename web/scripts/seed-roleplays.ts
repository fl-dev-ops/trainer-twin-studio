/**
 * Seeds role plays (web/data/roleplays/<set>/*.json: { slug, builder }) into one organization, through the
 * builder's own save (saveRoleplay). Seed the personas they use first (scripts/seed-persona-presets.ts).
 *
 *   bun scripts/seed-roleplays.ts --org <org id or slug> --set olga-leads [--dry-run]
 *
 * Idempotent: an unchanged role play keeps its version; a changed one gets the next version.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@/lib/db";
import { roleplayBuilderSchema } from "@/lib/roleplay/skill";
import { saveRoleplay } from "@/lib/scenario-ingest";

const arg = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : undefined;
};

async function main() {
  const orgArg = arg("org");
  const set = arg("set");
  if (!orgArg || !set) throw new Error("--org <id or slug> and --set <folder> are required");
  const org = await db.organization.findFirst({ where: { OR: [{ id: orgArg }, { slug: orgArg }] }, select: { id: true, slug: true } });
  if (!org) throw new Error(`Organization not found: ${orgArg}`);
  const dir = join(import.meta.dir, "../data/roleplays", set);
  for (const file of (await readdir(dir)).filter((name) => name.endsWith(".json")).sort()) {
    const { slug, builder } = JSON.parse(await readFile(join(dir, file), "utf8")) as { slug: string; builder: unknown };
    if (`${slug}.json` !== file) throw new Error(`Invalid role play ${set}/${file}`);
    const parsed = roleplayBuilderSchema.parse(builder);
    if (process.argv.includes("--dry-run")) {
      const persona = await db.persona.findFirst({ where: { orgId: org.id, slug: parsed.persona }, select: { id: true } });
      console.log(`[dry run] ${slug} (persona ${parsed.persona}: ${persona ? "found" : "MISSING"})`);
      continue;
    }
    // The full agent slug: saveRoleplay creates it when missing and versions it when it exists.
    const saved = await saveRoleplay(org.id, parsed, `${org.slug}-${slug}`);
    console.log(`saved    ${saved.slug} v${saved.version}`);
  }
  console.log(`done for org ${org.slug}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

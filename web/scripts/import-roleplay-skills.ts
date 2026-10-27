/**
 * Imports the seed role plays (web/data/roleplay/skills/<slug>/builder.json) into one organization.
 *
 *   bun scripts/import-roleplay-skills.ts --org <org id or slug> [--only <slug>] [--dry-run]
 *
 * Each builder is rendered into SKILL.md + scenario.json + items.json + after and stored like a skill twin
 * (S3 files, Chroma items, Agent kind ROLEPLAY) as `<org>-<folder name>`. The client persona (`persona` in the
 * builder) must already be in the org: run scripts/seed-persona-presets.ts first. Idempotent: unchanged role plays
 * keep their version.
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
const root = join(import.meta.dir, "../data/roleplay/skills");

const orgArg = arg("org");
if (!orgArg) throw new Error("Pass --org <org id or slug>");
const org = await db.organization.findFirst({ where: { OR: [{ id: orgArg }, { slug: orgArg }] }, select: { id: true, slug: true } });
if (!org) throw new Error(`Organization "${orgArg}" not found`);

const only = arg("only");
for (const slug of (await readdir(root)).filter((name) => !only || name === only).sort()) {
  const builder = roleplayBuilderSchema.parse(JSON.parse(await readFile(join(root, slug, "builder.json"), "utf8")));
  if (process.argv.includes("--dry-run")) {
    const persona = await db.persona.findFirst({ where: { orgId: org.id, slug: builder.persona }, select: { id: true } });
    console.log(`${org.slug}-${slug}: would save (persona ${builder.persona} ${persona ? "found" : "MISSING"})`);
    continue;
  }
  const saved = await saveRoleplay(org.id, builder, slug);
  console.log(`${saved.slug}: v${saved.version} ${saved.created ? "created" : "updated or unchanged"}, ${saved.items} items`);
}
await db.$disconnect();

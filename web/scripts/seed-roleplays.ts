/**
 * Seeds role plays (web/data/roleplays/<set>/*.json: { slug, builder }) into one organization, through the
 * builder's own save (saveRoleplay). Seed the personas they use first (scripts/seed-persona-presets.ts).
 *
 *   bun scripts/seed-roleplays.ts --org <org id or slug> --set olga-leads [--dry-run]
 *
 * Idempotent: an unchanged role play keeps its version; a changed one gets the next version. A file with `personas`
 * (persona slugs, the builder's persona first) also sets the role play's persona pool: each session plays one of them
 * at random (specs/agents.md).
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@/lib/db";
import { roleplayBuilderSchema } from "@/lib/roleplay/skill";
import { saveRoleplay } from "@/lib/scenario-ingest";
import { setAgentPersonas } from "@/lib/agent-personas";

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
    const { slug, builder, personas: pool } = JSON.parse(await readFile(join(dir, file), "utf8")) as { slug: string; builder: unknown; personas?: string[] };
    if (`${slug}.json` !== file) throw new Error(`Invalid role play ${set}/${file}`);
    const parsed = roleplayBuilderSchema.parse(builder);
    if (process.argv.includes("--dry-run")) {
      const persona = await db.persona.findFirst({ where: { orgId: org.id, slug: parsed.persona }, select: { id: true } });
      const found = pool ? await db.persona.count({ where: { orgId: org.id, slug: { in: pool } } }) : 0;
      console.log(`[dry run] ${slug} (persona ${parsed.persona}: ${persona ? "found" : "MISSING"}${pool ? `; pool ${found}/${pool.length} found` : ""})`);
      continue;
    }
    // The full agent slug: saveRoleplay creates it when missing and versions it when it exists.
    const saved = await saveRoleplay(org.id, parsed, `${org.slug}-${slug}`);
    console.log(`saved    ${saved.slug} v${saved.version}`);
    if (pool) {
      const rows = await db.persona.findMany({ where: { orgId: org.id, slug: { in: pool } }, select: { id: true, slug: true } });
      const idOf = new Map(rows.map((row) => [row.slug, row.id]));
      const missing = pool.filter((personaSlug) => !idOf.has(personaSlug));
      if (missing.length) throw new Error(`${slug}: personas not found: ${missing.join(", ")}`);
      const agent = await db.agent.findUniqueOrThrow({ where: { slug: saved.slug }, select: { id: true, personaId: true } });
      const ordered = [agent.personaId, ...pool.map((personaSlug) => idOf.get(personaSlug)!).filter((id) => id !== agent.personaId)];
      await db.$transaction((tx) => setAgentPersonas(agent.id, ordered.map((personaId) => ({ personaId, active: true })), tx));
      console.log(`pool     ${saved.slug}: ${ordered.length} personas`);
    }
  }
  console.log(`done for org ${org.slug}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

/**
 * Imports the client role-play seed (data/roleplay/seed.yaml) into one organization:
 * client personas through the normal persona spec path, scenarios through the
 * same draft → publish flow the role-play builder uses.
 *
 *   bun scripts/import-roleplay.ts --org latencytest           # dry run (default)
 *   bun scripts/import-roleplay.ts --org latencytest --apply   # write
 *
 * Scenario slugs are prefixed with the org slug because agent slugs are global.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { db } from "../lib/db";
import { buildRoleplayBundle, roleplayInputSchema } from "../lib/roleplay";
import { publishSpecDraft, saveSpecDraft } from "../lib/spec-drafts";
import { specDraftBundleSchema } from "../lib/spec-draft-schema";
import { saveSpec } from "../lib/specs";

type SeedPersona = Record<string, unknown> & { slug: string; name: string };
type Seed = { personas: SeedPersona[]; scenarios: (Record<string, unknown> & { slug: string })[] };

const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

async function main() {
  const orgSlug = arg("--org");
  const apply = process.argv.includes("--apply");
  if (!orgSlug) throw new Error("Usage: bun scripts/import-roleplay.ts --org <slug> [--apply]");

  const dbUrl = process.env.DATABASE_URL ?? "";
  console.log(`Database: ${dbUrl.replace(/\/\/[^@]+@/, "//***@")}`);
  const org = await db.organization.findFirst({ where: { slug: orgSlug }, select: { id: true, slug: true, name: true } });
  if (!org) throw new Error(`Organization "${orgSlug}" not found`);
  console.log(`Organization: ${org.name} (${org.slug})  mode: ${apply ? "APPLY" : "dry run"}\n`);

  const seed = yaml.load(await readFile(path.join(import.meta.dir, "../data/roleplay/seed.yaml"), "utf8")) as Seed;

  for (const { slug, ...persona } of seed.personas) {
    const existing = await db.persona.findUnique({ where: { orgId_slug: { orgId: org.id, slug } }, select: { version: true, data: true } });
    if (existing && (existing.data as { kind?: string } | null)?.kind !== "client") {
      throw new Error(`Persona "${slug}" already exists in ${org.slug} and is not a client persona; refusing to overwrite`);
    }
    if (persona.voiceId) {
      const voice = await db.voice.findFirst({ where: { id: String(persona.voiceId), OR: [{ orgId: org.id }, { orgId: null }] }, select: { id: true } });
      if (!voice) throw new Error(`Voice "${persona.voiceId}" for persona "${slug}" is not available`);
    }
    console.log(`${existing ? "update" : "create"} persona  ${slug}  (${persona.name}, ${persona.role})`);
    if (apply) {
      await saveSpec("personas", slug, yaml.dump({ schema_version: 1, kind: "persona", persona: { id: slug, kind: "client", ...persona } }), org.id);
    }
  }

  for (const { slug: baseSlug, ...raw } of seed.scenarios) {
    const slug = `${org.slug}-${baseSlug}`;
    const input = roleplayInputSchema.parse(raw);
    const persona = seed.personas.find((p) => p.slug === input.persona);
    if (!persona) throw new Error(`Scenario "${baseSlug}" uses unknown persona "${input.persona}"`);
    const existingAgent = await db.agent.findUnique({ where: { slug }, select: { orgId: true, version: true, domainSlug: true } });
    if (existingAgent && existingAgent.orgId !== org.id) throw new Error(`Scenario slug "${slug}" belongs to another organization`);
    const bundle = buildRoleplayBundle(
      { ...input, voiceId: input.voiceId ?? (typeof persona.voiceId === "string" ? persona.voiceId : undefined) },
      { slug, agentVersion: existingAgent?.version, domainId: existingAgent?.domainSlug },
    );
    specDraftBundleSchema.parse(bundle);
    console.log(`${existingAgent ? "update" : "create"} scenario ${slug}  (${input.name}; ${input.learnerGoals.length} goals; persona ${input.persona})`);
    if (apply) {
      await saveSpecDraft(bundle, org.id);
      const published = await publishSpecDraft(slug, org.id);
      console.log(`  published agent v${published.agentVersion}, domain v${published.domainVersion}`);
    }
  }

  if (!apply) console.log("\nDry run only. Re-run with --apply to write.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

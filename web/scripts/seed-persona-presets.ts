/**
 * Seeds the preset personas (web/data/personas/presets/<client>/*.json) into one organization.
 *
 *   bun scripts/seed-persona-presets.ts --org <org id or slug> [--client olga|vasanth] [--media] [--dry-run]
 *
 * Presets are not the user's own persona (isOwn = false). Prompt fields go to Persona.data in the shape the
 * role-play brain reads; pace goes to Persona.settings. Voice/avatar briefs stay in the JSON.
 * --media also gives each persona its own avatar photo (`media.image`, next to the JSON) and its own voice, cloned
 * from a sample voice's reference audio + transcript (`media.voice_sample`). Media a persona already has is kept.
 * Idempotent: a changed preset gets a new version (the previous data is kept in SpecVersion), an unchanged one is skipped.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { personaSettingsSchema, setPersonaAvatar, setPersonaVoice } from "@/lib/persona-media";
import { getObjectBytes, getObjectText } from "@/lib/s3";

type Preset = {
  slug: string;
  client: string;
  isOwn: false;
  name: string;
  prompt: {
    role: string; age: number; based_in: string; background: string; behaviours: string[]; opening_style: string;
    formality: string; answer_length: string; interrupts: string; pauses: boolean; fillers: boolean;
    signature_phrases: string[]; how_they_talk: string;
  };
  program: { pace: string };
  media?: { image?: string; voice_sample?: string };
};

const arg = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : undefined;
};
const dryRun = process.argv.includes("--dry-run");
const withMedia = process.argv.includes("--media");
const root = join(import.meta.dir, "../data/personas/presets");

/** Postgres jsonb reorders keys, so compare by content, not by text. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
    : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** Persona.data: prompt fields only (what the agent reads). */
function personaData(preset: Preset) {
  const p = preset.prompt;
  return {
    id: preset.slug,
    name: preset.name,
    role: p.role,
    age: p.age,
    based_in: p.based_in,
    background: p.background,
    behaviours: p.behaviours,
    opening_style: p.opening_style,
    how_they_talk: p.how_they_talk,
    mannerisms: { formality: p.formality, answer_length: p.answer_length, interrupts: p.interrupts, pauses: p.pauses, fillers: p.fillers },
    signature_phrases: p.signature_phrases,
  };
}

/** Gives the persona its own photo and voice from the preset, unless it already has them. */
async function attachMedia(orgId: string, client: string, preset: Preset) {
  const row = await db.persona.findFirstOrThrow({ where: { orgId, slug: preset.slug }, select: { voiceId: true, avatar: { select: { s3ImageKey: true } } } });
  if (preset.media?.image && !row.avatar?.s3ImageKey) {
    const bytes = await readFile(join(root, client, preset.media.image));
    await setPersonaAvatar(orgId, preset.slug, { image: new File([bytes], preset.media.image, { type: "image/jpeg" }) });
    console.log(`  photo   ${preset.media.image}`);
  }
  if (preset.media?.voice_sample && !row.voiceId) {
    const sample = await db.voice.findFirst({ where: { id: preset.media.voice_sample, orgId: null, status: "ready" } });
    if (!sample) throw new Error(`Sample voice not found: ${preset.media.voice_sample}`);
    const [audio, transcript] = await Promise.all([
      getObjectBytes(sample.s3AudioKey),
      sample.s3TranscriptKey ? getObjectText(sample.s3TranscriptKey) : Promise.resolve(""),
    ]);
    await setPersonaVoice(orgId, preset.slug, { audio: new File([audio], "reference.wav", { type: "audio/wav" }), transcript });
    console.log(`  voice   from ${sample.id}`);
  }
}

async function main() {
  const orgArg = arg("org");
  if (!orgArg) throw new Error("--org <id or slug> is required");
  const org = await db.organization.findFirst({ where: { OR: [{ id: orgArg }, { slug: orgArg }] }, select: { id: true, slug: true } });
  if (!org) throw new Error(`Organization not found: ${orgArg}`);
  const clients = arg("client") ? [arg("client")!] : (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);

  for (const client of clients) {
    for (const file of (await readdir(join(root, client))).filter((name) => name.endsWith(".json")).sort()) {
      const preset = JSON.parse(await readFile(join(root, client, file), "utf8")) as Preset;
      if (preset.isOwn !== false || `${preset.slug}.json` !== file) throw new Error(`Invalid preset ${client}/${file}`);
      const data = personaData(preset) as Prisma.InputJsonValue;
      const settings = personaSettingsSchema.parse(preset.program) as Prisma.InputJsonValue;
      const existing = await db.persona.findFirst({ where: { orgId: org.id, slug: preset.slug } });

      if (!existing) {
        if (!dryRun) await db.persona.create({ data: { orgId: org.id, slug: preset.slug, name: preset.name, version: 1, data, settings, isOwn: false } });
        console.log(`created  ${client}/${preset.slug} (${preset.name})`);
      } else if (existing.isOwn) {
        throw new Error(`${preset.slug} exists as someone's own persona in ${org.slug}; refusing to overwrite`);
      } else if (same(existing.data, data) && same(existing.settings, settings)) {
        console.log(`same     ${client}/${preset.slug}`);
      } else {
        if (!dryRun) {
          await db.$transaction([
            db.specVersion.create({ data: { entityType: "personas", entitySlug: preset.slug, version: existing.version, data: existing.data as Prisma.InputJsonValue, orgId: org.id } }),
            db.persona.update({ where: { id: existing.id }, data: { name: preset.name, version: existing.version + 1, data, settings } }),
          ]);
        }
        console.log(`updated  ${client}/${preset.slug} -> v${existing.version + 1}`);
      }
      if (withMedia && !dryRun) await attachMedia(org.id, client, preset);
    }
  }
  console.log(`${dryRun ? "[dry run] " : ""}done for org ${org.slug}`);
}

await main().finally(() => db.$disconnect());

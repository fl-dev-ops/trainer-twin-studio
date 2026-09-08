import type { Prisma } from "../lib/generated/prisma/client";
import { db } from "../lib/db";
import { MainCollectionService } from "../lib/main-collection";
import { extractPersonaVoiceChunks } from "../lib/persona-voice";

const dryRun = process.argv.includes("--dry-run");
const targetOrg = process.argv.find((arg, i, arr) => arr[i - 1] === "--org");

console.log("=== Persona Voice Migration to Org Main Collection ===");
if (dryRun) console.log("Mode: --dry-run (no writes to Chroma)");
if (targetOrg) console.log(`Filter: target org = ${targetOrg}`);

const sources = await db.personaSource.findMany({
  where: {
    status: "analyzed",
    ...(targetOrg ? { orgId: targetOrg } : {}),
  },
  select: {
    id: true,
    orgId: true,
    personaId: true,
    name: true,
    analysis: true,
    metadata: true,
  },
  orderBy: { createdAt: "asc" },
});

console.log(`Found ${sources.length} analyzed persona source(s) to process.\n`);

let migratedSources = 0;
let migratedMoments = 0;
let failedSources = 0;
let skippedSources = 0;

for (const source of sources) {
  const sourceNum = migratedSources + failedSources + skippedSources + 1;
  const progressPct = sources.length > 0 ? ((sourceNum / sources.length) * 100).toFixed(1) : "100.0";
  const prefix = `[${sourceNum}/${sources.length}] (${progressPct}%)`;

  try {
    const chunks = extractPersonaVoiceChunks(source.analysis);
    if (!chunks.length) {
      console.warn(`  ${prefix} [SKIP] "${source.name}" (${source.id}): No conversation moments extracted from analysis.`);
      skippedSources++;
      continue;
    }

    if (dryRun) {
      console.log(`  ${prefix} [DRY-RUN] Would ingest "${source.name}" (${chunks.length} moments) -> org ${source.orgId}, persona ${source.personaId}`);
      migratedSources++;
      migratedMoments += chunks.length;
      continue;
    }

    // Idempotent: deletes any previous moments for source.id before upserting
    const count = await MainCollectionService.ingestPersonaVoice(
      source.orgId,
      source.personaId,
      source.id,
      source.name,
      chunks,
    );

    const metadata = source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata)
      ? (source.metadata as Record<string, unknown>)
      : {};

    await db.personaSource.update({
      where: { id: source.id },
      data: {
        metadata: { ...metadata, voiceMoments: count } as Prisma.InputJsonValue,
      },
    });

    console.log(`  ${prefix} [OK] Ingested "${source.name}" (${count} moments) -> org ${source.orgId}`);
    migratedSources++;
    migratedMoments += count;
  } catch (error) {
    console.error(`  ${prefix} [FAILED] "${source.name}" (${source.id}):`, error);
    failedSources++;
  }
}

console.log(`\n=== Persona Voice Migration Summary ===`);
console.log(`Sources Migrated: ${migratedSources} | Moments Migrated: ${migratedMoments} | Skipped: ${skippedSources} | Failed: ${failedSources}`);

await db.$disconnect();
process.exit(failedSources > 0 ? 1 : 0);

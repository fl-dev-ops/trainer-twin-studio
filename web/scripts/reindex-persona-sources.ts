import type { Prisma } from "../lib/generated/prisma/client";
import { db } from "../lib/db";
import { removeCollection, replaceChunks } from "../lib/knowledge";
import { MainCollectionService } from "../lib/main-collection";
import { extractPersonaVoiceChunks, personaCollectionName } from "../lib/persona-voice";

const cleanupLegacy = process.argv.includes("--cleanup-legacy");
const sources = await db.personaSource.findMany({
  where: { status: { in: ["analyzed", "failed"] } },
  select: { id: true, orgId: true, personaId: true, name: true, analysis: true, metadata: true },
});
let indexed = 0;
let failed = 0;
for (const source of sources) {
  const existingMoments = source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata)
    ? (source.metadata as Record<string, unknown>).voiceMoments
    : 0;
  if (typeof existingMoments === "number" && existingMoments > 0) continue;
  const chunks = extractPersonaVoiceChunks(source.analysis);
  if (!chunks.length) continue;
  try {
    await MainCollectionService.ingestPersonaVoice(source.orgId, source.personaId, source.id, source.name, chunks);
    try {
      await replaceChunks(personaCollectionName(source.personaId), source.id, source.name, chunks);
    } catch {
      // legacy update optional
    }
    const metadata = source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata)
      ? source.metadata as Record<string, unknown>
      : {};
    await db.personaSource.update({
      where: { id: source.id },
      data: {
        status: "analyzed",
        metadata: { ...metadata, voiceMoments: chunks.length } as Prisma.InputJsonValue,
      },
    });
    indexed++;
    console.log(`indexed ${source.name}: ${chunks.length} moments`);
  } catch (error) {
    failed++;
    console.error(`failed ${source.name}:`, error);
  }
}
const personas = await db.persona.findMany({
  where: { sources: { some: {} } },
  select: { id: true, slug: true },
});
if (cleanupLegacy) {
  for (const persona of personas) {
    const legacyCollection = `persona_${persona.slug}`;
    if (legacyCollection !== personaCollectionName(persona.id)) {
      await removeCollection(legacyCollection);
      console.log(`removed legacy collection ${legacyCollection}`);
    }
  }
}

console.log(`done: ${indexed} indexed, ${failed} failed`);
if (failed) process.exitCode = 1;

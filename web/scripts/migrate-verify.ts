import type { Where } from "chromadb";
import { db } from "../lib/db";
import { MainCollectionService } from "../lib/main-collection";

const targetOrg = process.argv.find((arg, i, arr) => arr[i - 1] === "--org");

console.log("=== Chroma Migration Verification ===");
if (targetOrg) console.log(`Filter: target org = ${targetOrg}`);

const orgs = await db.organization.findMany({
  where: targetOrg ? { id: targetOrg } : undefined,
  select: { id: true, name: true, slug: true, chromaTenantId: true, chromaDatabase: true },
  orderBy: { createdAt: "asc" },
});

console.log(`Verifying ${orgs.length} organization(s)...\n`);

let allPassed = true;

for (const org of orgs) {
  console.log(`\n======================================================`);
  console.log(`Organization: "${org.name}" (${org.slug})`);
  console.log(`ID: ${org.id}`);
  console.log(`Chroma Tenant: ${org.chromaTenantId ?? "unprovisioned"} | Database: ${org.chromaDatabase ?? "default"}`);

  // Query Postgres counts
  const pgDocCount = await db.knowledgeDocument.count({
    where: { kb: { orgId: org.id }, status: "indexed" },
  });
  const pgSourceCount = await db.personaSource.count({
    where: { orgId: org.id, status: "analyzed" },
  });

  console.log(`Postgres stats: ${pgDocCount} indexed doc(s), ${pgSourceCount} analyzed persona source(s)`);

  try {
    const collection = await MainCollectionService.getCollection(org.id);
    const totalItems = await collection.count();
    console.log(`Main Chroma collection: "${collection.name}" (Total items: ${totalItems})`);

    // Chroma count by type
    let knowledgeCount = 0;
    let personaVoiceCount = 0;

    try {
      const kRes = await collection.get({
        where: { type: "knowledge" } as Where,
      });
      knowledgeCount = kRes.ids.length;
    } catch {
      // get with where might return empty or error if no match
    }

    try {
      const pvRes = await collection.get({
        where: { type: "persona_voice" } as Where,
      });
      personaVoiceCount = pvRes.ids.length;
    } catch {
      // get with where might return empty or error if no match
    }

    console.log(`Chroma breakdown: ${knowledgeCount} knowledge chunk(s), ${personaVoiceCount} persona voice moment(s)`);

    // Verification checks
    if (pgDocCount > 0 && knowledgeCount === 0) {
      console.warn(`  [WARN] Org has ${pgDocCount} docs in Postgres but 0 knowledge chunks in Chroma!`);
      allPassed = false;
    } else if (pgDocCount > 0) {
      console.log(`  [PASS] Knowledge chunks present (${knowledgeCount} chunks for ${pgDocCount} docs).`);
    }

    if (pgSourceCount > 0 && personaVoiceCount === 0) {
      console.warn(`  [WARN] Org has ${pgSourceCount} sources in Postgres but 0 persona voice moments in Chroma!`);
      allPassed = false;
    } else if (pgSourceCount > 0) {
      console.log(`  [PASS] Persona voice moments present (${personaVoiceCount} moments for ${pgSourceCount} sources).`);
    }

    // Retrieval tests
    if (knowledgeCount > 0) {
      console.log(`  [TEST] Running sample knowledge retrieval query ("interview core concepts")...`);
      const hits = await MainCollectionService.searchKnowledge(org.id, "interview core concepts", { limit: 2 });
      console.log(`  [RESULT] Knowledge search returned ${hits.length} hit(s):`);
      hits.forEach((h, idx) => {
        console.log(`    ${idx + 1}. [score: ${h.score.toFixed(3)}] ${h.source}: ${h.text.slice(0, 70)}...`);
      });
    }

    if (personaVoiceCount > 0) {
      console.log(`  [TEST] Running sample persona voice retrieval query ("ask question")...`);
      const hits = await MainCollectionService.searchPersonaVoice(org.id, "ask question", { limit: 2 });
      console.log(`  [RESULT] Persona voice search returned ${hits.length} hit(s):`);
      hits.forEach((h, idx) => {
        console.log(`    ${idx + 1}. [score: ${h.score.toFixed(3)}] ${h.text.slice(0, 70)}...`);
      });
    }

  } catch (error) {
    console.error(`  [ERROR] Verification failed for org ${org.id}:`, error);
    allPassed = false;
  }
}

console.log(`\n======================================================`);
if (allPassed) {
  console.log(`All organizations verified successfully!`);
} else {
  console.log(`Verification completed with warnings or errors.`);
}

await db.$disconnect();
process.exit(allPassed ? 0 : 1);

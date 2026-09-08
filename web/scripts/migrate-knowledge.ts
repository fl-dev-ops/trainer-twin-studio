import { db } from "../lib/db";
import { chunkMarkdown } from "../lib/knowledge";
import { MainCollectionService } from "../lib/main-collection";
import { getObjectText } from "../lib/s3";

const dryRun = process.argv.includes("--dry-run");
const includeAll = process.argv.includes("--all");
const targetOrg = process.argv.find((arg, i, arr) => arr[i - 1] === "--org");

console.log("=== Knowledge Migration to Org Main Collection ===");
if (dryRun) console.log("Mode: --dry-run (no writes to Chroma)");
if (includeAll) console.log("Mode: --all (processing all docs with markdown, not just indexed)");
if (targetOrg) console.log(`Filter: target org = ${targetOrg}`);

const bases = await db.knowledgeBase.findMany({
  where: targetOrg ? { orgId: targetOrg } : undefined,
  include: {
    documents: {
      where: includeAll ? undefined : { status: "indexed" },
      orderBy: { createdAt: "asc" },
    },
  },
  orderBy: { createdAt: "asc" },
});

const totalDocs = bases.reduce((sum, b) => sum + b.documents.length, 0);
console.log(`Found ${bases.length} knowledge base(s) with ${totalDocs} document(s) to process.\n`);

let migratedDocs = 0;
let migratedChunks = 0;
let failedDocs = 0;

for (const base of bases) {
  console.log(`\n--- Knowledge Base: "${base.name}" (${base.slug}) | Org: ${base.orgId ?? "none"} ---`);
  if (!base.orgId) {
    console.warn("  [SKIP] Knowledge base has no orgId associated.");
    continue;
  }
  if (!base.documents.length) {
    console.log("  No matching documents found.");
    continue;
  }

  for (const doc of base.documents) {
    const docNum = migratedDocs + failedDocs + 1;
    const progressPct = totalDocs > 0 ? ((docNum / totalDocs) * 100).toFixed(1) : "100.0";
    const prefix = `[${docNum}/${totalDocs}] (${progressPct}%)`;

    try {
      if (!doc.s3MarkdownKey) {
        console.warn(`  ${prefix} [SKIP] ${doc.slug}: No s3MarkdownKey defined.`);
        continue;
      }

      const markdown = await getObjectText(doc.s3MarkdownKey);
      if (!markdown || !markdown.trim()) {
        console.warn(`  ${prefix} [SKIP] ${doc.slug}: Markdown content is empty.`);
        continue;
      }

      const chunks = chunkMarkdown(markdown);
      if (!chunks.length) {
        console.warn(`  ${prefix} [SKIP] ${doc.slug}: 0 chunks generated.`);
        continue;
      }

      if (dryRun) {
        console.log(`  ${prefix} [DRY-RUN] Would ingest ${doc.slug} (${chunks.length} chunks) -> org ${base.orgId}`);
        migratedDocs++;
        migratedChunks += chunks.length;
        continue;
      }

      // Idempotent: deletes any previous chunks for doc.id before upserting
      const count = await MainCollectionService.ingestKnowledgeDoc(
        base.orgId,
        base.id,
        doc.id,
        doc.slug,
        doc.title || doc.slug,
        chunks,
      );

      console.log(`  ${prefix} [OK] Ingested ${doc.slug} (${count} chunks)`);
      migratedDocs++;
      migratedChunks += count;
    } catch (error) {
      console.error(`  ${prefix} [FAILED] ${doc.slug}:`, error);
      failedDocs++;
    }
  }
}

console.log(`\n=== Knowledge Migration Summary ===`);
console.log(`Documents Migrated: ${migratedDocs} | Chunks Migrated: ${migratedChunks} | Failed: ${failedDocs}`);

await db.$disconnect();
process.exit(failedDocs > 0 ? 1 : 0);

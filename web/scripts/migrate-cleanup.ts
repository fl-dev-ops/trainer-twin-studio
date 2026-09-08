import { ChromaClient, CloudClient } from "chromadb";

const CHROMA_URL = process.env.CHROMA_URL;
const CHROMA_API_KEY = process.env.CHROMA_API_KEY ?? "";
const CHROMA_TENANT = process.env.CHROMA_TENANT ?? "default_tenant";
const CHROMA_DATABASE = process.env.CHROMA_DATABASE ?? "default_database";

const confirm = process.argv.includes("--confirm");

console.log("=== Legacy Chroma Collections Cleanup ===");
if (!confirm) {
  console.log("Safety Mode: DRY RUN (no collections will be deleted). Pass --confirm to execute deletion.\n");
} else {
  console.log("CAUTION: Deletion mode ACTIVE (--confirm provided).\n");
}

let client: ChromaClient;
if (CHROMA_URL) {
  const u = new URL(CHROMA_URL);
  client = new ChromaClient({
    host: u.hostname,
    port: Number(u.port) || (u.protocol === "https:" ? 443 : 8000),
    ssl: u.protocol === "https:",
    tenant: CHROMA_TENANT,
    database: CHROMA_DATABASE,
  });
} else if (CHROMA_API_KEY) {
  client = new CloudClient({
    apiKey: CHROMA_API_KEY,
    tenant: CHROMA_TENANT,
    database: CHROMA_DATABASE,
  });
} else {
  client = new ChromaClient({
    host: "localhost",
    port: 8000,
    ssl: false,
    tenant: CHROMA_TENANT,
    database: CHROMA_DATABASE,
  });
}

const allCollections = await client.listCollections();
const collectionNames = allCollections.map((c) => (typeof c === "string" ? c : c.name));

// Match legacy collection patterns: kb_<id or slug>, persona_<id or slug>
const legacyCollections = collectionNames.filter((name) => {
  if (name.startsWith("kb_")) return true;
  if (name.startsWith("persona_")) return true;
  return false;
});

console.log(`Found ${collectionNames.length} total collection(s).`);
console.log(`Identified ${legacyCollections.length} legacy collection(s) eligible for cleanup:`);
legacyCollections.forEach((name) => console.log(` - ${name}`));

if (legacyCollections.length === 0) {
  console.log("\nNo legacy collections found to clean up.");
  process.exit(0);
}

if (!confirm) {
  console.log(`\nDry run finished. 0 collections deleted.`);
  console.log(`To delete the ${legacyCollections.length} collection(s) listed above, run:`);
  console.log(`  bun scripts/migrate-cleanup.ts --confirm`);
  process.exit(0);
}

let deleted = 0;
let failed = 0;

for (const name of legacyCollections) {
  try {
    await client.deleteCollection({ name });
    console.log(`[DELETED] ${name}`);
    deleted++;
  } catch (error) {
    console.error(`[FAILED] ${name}:`, error);
    failed++;
  }
}

console.log(`\n=== Cleanup Summary ===`);
console.log(`Deleted: ${deleted} | Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);

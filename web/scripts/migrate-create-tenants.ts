import { db } from "../lib/db";
import { ChromaTenantService } from "../lib/chroma-tenant";

const force = process.argv.includes("--force");
const targetOrg = process.argv.find((arg, i, arr) => arr[i - 1] === "--org");

console.log("=== Chroma Tenant Migration ===");
if (force) console.log("Mode: --force enabled (will re-provision existing tenants)");
if (targetOrg) console.log(`Filter: target org = ${targetOrg}`);

const orgs = await db.organization.findMany({
  where: targetOrg ? { id: targetOrg } : undefined,
  select: { id: true, name: true, slug: true, chromaTenantId: true, chromaDatabase: true },
  orderBy: { createdAt: "asc" },
});

console.log(`Found ${orgs.length} organization(s) to process.\n`);

let provisioned = 0;
let skipped = 0;
let failed = 0;

for (const org of orgs) {
  if (org.chromaTenantId && !force) {
    console.log(`[SKIP] "${org.name}" (${org.id}) already provisioned -> tenant: ${org.chromaTenantId}, db: ${org.chromaDatabase}`);
    skipped++;
    continue;
  }

  try {
    const result = await ChromaTenantService.createOrgDatabase(org.id);
    console.log(`[PROVISIONED] "${org.name}" (${org.id}) -> tenant: ${result.tenantId}, db: ${result.database}`);
    provisioned++;
  } catch (error) {
    console.error(`[FAILED] "${org.name}" (${org.id}):`, error);
    failed++;
  }
}

console.log(`\n=== Summary ===`);
console.log(`Total: ${orgs.length} | Provisioned: ${provisioned} | Skipped: ${skipped} | Failed: ${failed}`);

await db.$disconnect();
process.exit(failed > 0 ? 1 : 0);

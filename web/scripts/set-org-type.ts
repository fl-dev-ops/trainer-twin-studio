/**
 * Sets an organization's type. Developers only; there is no UI for this.
 * Scenarios of the other kind are not touched: list them with
 * scripts/remove-mismatched-scenarios.ts.
 *
 * Usage: bun scripts/set-org-type.ts <org-slug> <SALES|TECHNICAL_INTERVIEW>
 */
import { db } from "../lib/db";
import { isOrgType } from "../lib/org-type";

const [slug, type] = process.argv.slice(2);
if (!slug || !isOrgType(type)) {
  console.error("Usage: bun scripts/set-org-type.ts <org-slug> <SALES|TECHNICAL_INTERVIEW>");
  process.exit(1);
}

const org = await db.organization.findUnique({ where: { slug }, select: { id: true, type: true } });
if (!org) {
  console.error(`No organization with slug "${slug}".`);
  process.exit(1);
}

await db.organization.update({ where: { id: org.id }, data: { type } });
console.log(`${slug}: ${org.type} -> ${type}`);
process.exit(0);

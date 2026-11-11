/**
 * Saves every billed org's billing details to its Meteroid customer again (lib/billing/details.ts
 * meteroidCustomerPatch): after the tax wording changes, e.g. once GST_LUT_REFERENCE is set, so export customers'
 * next invoices carry the LUT number. Run with the same env as the app (METEROID_API_KEY, GST_LUT_REFERENCE).
 *   bun scripts/billing-sync-customers.ts [--dry-run]
 */
import { db } from "@/lib/db";
import { meteroidCustomerPatch, taxFor, type BillingDetails } from "@/lib/billing/details";
import { patchCustomer } from "@/lib/billing/meteroid";

const dryRun = process.argv.includes("--dry-run");
const orgs = await db.orgBilling.findMany({ where: { billingDetails: { not: { equals: null } } }, select: { orgId: true, meteroidCustomerId: true, billingDetails: true, organization: { select: { slug: true } } } });
for (const org of orgs) {
  const details = org.billingDetails as unknown as BillingDetails;
  const patch = meteroidCustomerPatch(details);
  console.log(`${dryRun ? "would save" : "saving"} ${org.organization.slug}: ${taxFor(details).kind}${patch.exemption_reason ? ` (${patch.exemption_reason})` : ""}`);
  if (!dryRun) await patchCustomer(org.meteroidCustomerId, patch);
}
await db.$disconnect();

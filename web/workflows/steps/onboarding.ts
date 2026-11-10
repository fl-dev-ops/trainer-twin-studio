import { ChromaTenantService } from "@/lib/chroma-tenant";
import { db } from "@/lib/db";
import { grantTrialMinutes, linkOrgToMeteroid } from "@/lib/org-billing-setup";

/**
 * Steps of the onboard-org workflow (../onboard-org.ts). Both are safe to repeat, so they're retried (the step
 * default) when Chroma or Meteroid fails for a moment.
 */

/** The org's own Chroma database (knowledge, question bank, learner memory). */
export async function createChromaDatabase(orgId: string) {
  "use step";
  await ChromaTenantService.createOrgDatabase(orgId);
}

/**
 * The org's Meteroid customer and Credits subscription (lib/org-credits.ts): its credits live there. Skipped when
 * this environment has no Meteroid (a local setup without METEROID_API_KEY): the org then isn't billed.
 */
export async function createBillingCustomer(orgId: string): Promise<string | null> {
  "use step";
  if (!process.env.METEROID_API_KEY?.trim()) {
    console.warn(`[onboard-org] ${orgId}: METEROID_API_KEY not set; the org isn't billed`);
    return null;
  }
  const org = await db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { id: true, slug: true, name: true } });
  return (await linkOrgToMeteroid(org)).customerId;
}

/** The free trial credits (lib/minutes-config.ts TRIAL_MINUTES, TRIAL_DAYS); granted once per org. */
export async function grantTrial(orgId: string, customerId: string) {
  "use step";
  const org = await db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { id: true, createdAt: true } });
  await grantTrialMinutes(org, customerId);
}

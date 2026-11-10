// Workflow: onboard a new org.
// After founder onboarding creates the org (app/api/onboarding), sets up what it runs on: its Chroma database, its
// Meteroid customer with a Credits subscription, and free trial credits. Run by lib/workflow-runs.ts runOnboarding.

import { createBillingCustomer, createChromaDatabase, grantTrial } from "./steps/onboarding";

export async function onboardOrg(orgId: string) {
  "use workflow";
  await createChromaDatabase(orgId);
  const meteroidCustomerId = await createBillingCustomer(orgId);
  if (meteroidCustomerId) await grantTrial(orgId, meteroidCustomerId);
  return { ok: true as const, meteroidCustomerId };
}

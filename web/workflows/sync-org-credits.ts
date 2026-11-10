// Workflow: sync org credits from Meteroid.
// When Meteroid says an org's credits changed (minutes granted or bought, spent), reads its balance and grants into
// the org's copy (OrgBilling), then emails the org's admin about each new grant. Started by the Meteroid webhook and
// Razorpay purchases; steps in ./steps/org-credits.ts.

import { announce, refresh } from "./steps/org-credits";

export async function syncOrgCredits(orgId: string) {
  "use workflow";
  await refresh(orgId, null);
  const announced = await announce(orgId);
  return { status: "refreshed" as const, announced };
}

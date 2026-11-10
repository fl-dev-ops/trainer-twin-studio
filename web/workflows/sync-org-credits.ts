// Workflow: sync org credits from Meteroid.
// When Meteroid says an org's credits changed (minutes granted or bought, spent), reads its balance and grants into
// the org's copy (OrgBilling). Started by the Meteroid webhook and Razorpay purchases; step in ./steps/org-credits.ts.

import { refresh } from "./steps/org-credits";

export async function syncOrgCredits(orgId: string) {
  "use workflow";
  await refresh(orgId, null);
  return { status: "refreshed" as const };
}

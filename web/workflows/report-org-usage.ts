// Workflow: report org usage to Meteroid.
// After an org spends credits (minutes given to learners, an admin/team call), sends Meteroid the usage and waits
// until its balance counts it. Started by lib/schedule-org-credits.ts; steps in ./steps/org-credits.ts.

import { sleep } from "workflow";
import { refresh, sendUsage } from "./steps/org-credits";

/** How long to wait for Meteroid to count usage we sent (it usually takes about 2 seconds). */
const COUNT_CHECKS = 20;
const COUNT_INTERVAL = "3s";

/**
 * Until Meteroid has counted the usage, lib/org-credits.ts takes it off itself. Not counted in time: the usage stays
 * sent, and the next refresh picks the balance up.
 */
export async function reportOrgUsage(orgId: string) {
  "use workflow";
  const sentAt = await sendUsage(orgId);
  for (let check = 0; check < COUNT_CHECKS; check++) {
    if (await refresh(orgId, sentAt)) return { status: sentAt ? "counted" as const : "refreshed" as const };
    await sleep(COUNT_INTERVAL);
  }
  return { status: "not_counted_yet" as const };
}

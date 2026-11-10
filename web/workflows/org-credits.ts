import { sleep } from "workflow";
import { refresh, sendUsage } from "./org-credits-steps";

/** How long to wait for Meteroid to count usage we sent (it usually takes about 2 seconds). */
const COUNT_CHECKS = 20;
const COUNT_INTERVAL = "3s";

/**
 * After the org spent credits (minutes given to learners, an admin/team call): sends Meteroid the usage, then waits
 * until Meteroid has counted it and keeps its new balance. Until then lib/org-credits.ts takes the usage off itself.
 * Not counted in time: the usage stays sent, and the next refresh picks the balance up.
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

/** Meteroid says the org's credits changed (grant added or expired, usage counted): keep its balance and grants. */
export async function syncOrgCredits(orgId: string) {
  "use workflow";
  await refresh(orgId, null);
  return { status: "refreshed" as const };
}

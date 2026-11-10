import { start } from "workflow/api";
import { reportOrgUsage } from "@/workflows/report-org-usage";
import { syncOrgCredits } from "@/workflows/sync-org-credits";

/**
 * Starts the org-credits workflows. Never throws: a run that can't start leaves the usage unsent, and the next run
 * for the org (another grant or call, a webhook, the Credits page) sends it.
 */
async function startQuietly(name: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    console.error(`[org-credits] could not start ${name}:`, error);
  }
}

export const scheduleOrgUsage = (orgId: string) => startQuietly("reportOrgUsage", () => start(reportOrgUsage, [orgId]));
export const scheduleOrgSync = (orgId: string) => startQuietly("syncOrgCredits", () => start(syncOrgCredits, [orgId]));

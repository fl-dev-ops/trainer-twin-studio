import { refreshOrgCredits, sendOrgUsage } from "@/lib/org-credits";

/** Steps of the report-org-usage and sync-org-credits workflows (lib/org-credits.ts). Retried on failure; safe to repeat. */

/** Sends Meteroid the org's unsent spending; when the last was sent, as ISO (null: nothing to send). */
export async function sendUsage(orgId: string): Promise<string | null> {
  "use step";
  return (await sendOrgUsage(orgId))?.toISOString() ?? null;
}

/** Reads the org's balance and grants from Meteroid; whether usage sent at `sentAt` is counted yet. */
export async function refresh(orgId: string, sentAt: string | null): Promise<boolean> {
  "use step";
  return (await refreshOrgCredits(orgId, sentAt ? new Date(sentAt) : null)).counted;
}

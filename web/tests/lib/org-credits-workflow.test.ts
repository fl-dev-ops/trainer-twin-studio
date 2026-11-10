import { beforeEach, expect, mock, test } from "bun:test";

let sentAt: string | null = "2026-01-01T00:00:00.000Z";
let countedAfter = 3;
const sends: string[] = [];
const refreshes: unknown[][] = [];
const announces: string[] = [];
const sleeps: string[] = [];
mock.module("workflow", () => ({ sleep: async (duration: string) => { sleeps.push(duration); } }));
mock.module("@/workflows/steps/org-credits", () => ({
  sendUsage: async (orgId: string) => { sends.push(orgId); return sentAt; },
  refresh: async (...args: unknown[]) => { refreshes.push(args); return refreshes.length >= countedAfter; },
  announce: async (orgId: string) => { announces.push(orgId); return 2; },
}));
const { reportOrgUsage } = await import("@/workflows/report-org-usage");
const { syncOrgCredits } = await import("@/workflows/sync-org-credits");
beforeEach(() => { sends.length = refreshes.length = sleeps.length = announces.length = 0; countedAfter = 3; sentAt = "2026-01-01T00:00:00.000Z"; });

test("reportOrgUsage sends once and polls every 3s until counted", async () => {
  expect(await reportOrgUsage("org")).toEqual({ status: "counted" });
  expect(sends).toEqual(["org"]);
  expect(refreshes).toEqual(Array.from({ length: 3 }, () => ["org", sentAt]));
  expect(sleeps).toEqual(["3s", "3s"]);
  expect(announces).toEqual([]);
});
test("reportOrgUsage stops after 20 checks, leaving sent rows for a later refresh", async () => {
  countedAfter = Infinity;
  expect(await reportOrgUsage("org")).toEqual({ status: "not_counted_yet" });
  expect(refreshes).toHaveLength(20);
  expect(sleeps).toHaveLength(20);
  expect(sends).toEqual(["org"]);
});
test("no unsent rows refreshes once without sleeping", async () => {
  sentAt = null; countedAfter = 1;
  expect(await reportOrgUsage("org")).toEqual({ status: "refreshed" });
  expect(sleeps).toEqual([]);
  expect(refreshes).toEqual([["org", null]]);
  expect(sends).toEqual(["org"]);
});
test("syncOrgCredits refreshes, then emails the admin about new grants (specs/people.md rule 11)", async () => {
  expect(await syncOrgCredits("org")).toEqual({ status: "refreshed", announced: 2 });
  expect(refreshes).toEqual([["org", null]]);
  expect(announces).toEqual(["org"]);
  expect(sends).toEqual([]);
});

import { expect, test } from "bun:test";
import { activity, categoryOf, type UsageRow } from "@/lib/usage-report";

const row = (over: Partial<UsageRow>): UsageRow => ({
  id: Math.random().toString(36), type: "usage", seconds: 0, email: "l@x.com", userId: "u1", actorUserId: null, note: null,
  createdAt: new Date("2026-11-10T10:00:00Z"), agentId: "a1", agentName: "Alex", kind: "TWIN", calibration: false, ...over,
});

test("categories: grants are assigned; learner calls by kind; team calls by calibration, then kind", () => {
  expect(categoryOf({ type: "grant", kind: null, calibration: false })).toBe("assigned");
  expect(categoryOf({ type: "reclaim", kind: null, calibration: false })).toBe("assigned");
  expect(categoryOf({ type: "usage", kind: "ROLEPLAY", calibration: false })).toBe("learnerRoleplay");
  expect(categoryOf({ type: "org_usage", kind: "TWIN", calibration: true })).toBe("calibration");
  expect(categoryOf({ type: "org_usage", kind: "ROLEPLAY", calibration: false })).toBe("teamRoleplay");
  expect(categoryOf({ type: "topup", kind: null, calibration: false })).toBeNull();
});

test("activity: totals, per agent, per team member, and the log", () => {
  const rows = [
    row({ type: "grant", seconds: 1800, actorUserId: "admin", agentId: null, agentName: null, kind: null }),
    row({ type: "usage", seconds: -600 }),
    row({ type: "org_usage", seconds: -300, userId: "admin", email: "a@x.com", calibration: true }),
    row({ type: "org_usage", seconds: -120, userId: "admin", email: "a@x.com", agentId: "r1", agentName: "Cold call", kind: "ROLEPLAY", createdAt: new Date("2026-11-11T09:00:00Z") }),
  ];
  const out = activity(rows, 7);
  expect(out.totals).toMatchObject({ assigned: 30, learnerTwin: 10, calibration: 5, teamRoleplay: 2 });
  expect(out.agents[0]).toMatchObject({ id: "a1", calls: 2, learnerMinutes: 10, teamMinutes: 5 });
  expect(out.team).toEqual([{ userId: "admin", email: "a@x.com", calibration: 5, twins: 0, roleplays: 2, total: 7 }]);
  expect(out.log.map((entry) => [entry.category, entry.minutes])).toEqual([["assigned", 30], ["learnerTwin", 10], ["calibration", 5], ["teamRoleplay", 2]]);
});

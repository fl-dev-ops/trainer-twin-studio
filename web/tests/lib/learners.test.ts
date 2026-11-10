import { expect, test } from "bun:test";
import { summarizeLearners } from "@/lib/learners";

const harini = { id: "u1", name: "Harini", email: "harini@x.com", image: null };
const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 20, h, m));

test("summarizes only org learners by account, including people who have not practised", () => {
  const rows = summarizeLearners({
    assignments: [
      { userId: "u1", agentId: "a1" },
      { userId: "u1", agentId: "a2" },
      { userId: "u2", agentId: "a1" },
      { userId: "u4", agentId: "a3" },
    ],
    sessions: [
      { agentId: "outside", user: { id: "not-a-member" }, startedAt: at(13), endedAt: at(14), createdAt: at(13) },
      { agentId: "a1", user: harini, startedAt: at(10), endedAt: at(10, 30), createdAt: at(10) },
      { agentId: "a3", user: harini, startedAt: at(12), endedAt: null, createdAt: at(12) }, // never ended
    ],
    learners: [harini, { id: "u3", name: "Member Only", email: "member@x.com", image: null }, { id: "u2", name: "New Person", email: "new@x.com", image: null }, { id: "u4", name: "", email: "added@x.com", image: null }],

  });

  expect(rows.map((r) => r.email)).toEqual(["harini@x.com", "added@x.com", "member@x.com", "new@x.com"]);
  expect(rows[0]).toMatchObject({ name: "Harini", userId: "u1", scenarioCount: 3, sessionCount: 2, practiceSeconds: 1800 });
  expect(rows[0].lastActiveAt).toBe(at(12).toISOString());
  expect(rows.find((r) => r.email === "new@x.com")).toMatchObject({ name: "New Person", userId: "u2", sessionCount: 0 });
  expect(rows.find((r) => r.email === "added@x.com")).toMatchObject({ name: "added@x.com", userId: "u4", scenarioCount: 1 });
  expect(rows.find((r) => r.email === "member@x.com")).toMatchObject({ scenarioCount: 0, sessionCount: 0 });
});

test("caps runaway sessions and ignores negative durations", () => {
  const [row] = summarizeLearners({
    assignments: [],
    sessions: [
      { agentId: "a1", user: harini, startedAt: at(0), endedAt: at(9), createdAt: at(0) },
      { agentId: "a1", user: harini, startedAt: at(10), endedAt: at(9), createdAt: at(10) },
    ],
    learners: [harini],

  });
  expect(row.practiceSeconds).toBe(3 * 60 * 60);
});

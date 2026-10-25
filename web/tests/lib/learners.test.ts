import { expect, test } from "bun:test";
import { summarizeLearners } from "@/lib/learners";

const harini = { id: "u1", name: "Harini", email: "harini@x.com", image: null };
const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 20, h, m));

test("merges assignments, sessions and members per learner", () => {
  const rows = summarizeLearners({
    assignments: [
      { recipientEmail: "Harini@x.com", agentId: "a1" },
      { recipientEmail: "harini@x.com", agentId: "a2" },
      { recipientEmail: "new@x.com", agentId: "a1" },
      { recipientEmail: "invited@x.com", agentId: "a3" },
    ],
    sessions: [
      { agentId: "a1", user: harini, startedAt: at(10), endedAt: at(10, 30), createdAt: at(10) },
      { agentId: "a3", user: harini, startedAt: at(12), endedAt: null, createdAt: at(12) }, // never ended
    ],
    members: [{ id: "u3", name: "Member Only", email: "member@x.com", image: null }],
    users: [{ id: "u2", name: "New Person", email: "new@x.com", image: null }],
  });

  expect(rows.map((r) => r.email)).toEqual(["harini@x.com", "invited@x.com", "member@x.com", "new@x.com"]);
  expect(rows[0]).toMatchObject({ name: "Harini", userId: "u1", scenarioCount: 3, sessionCount: 2, practiceSeconds: 1800 });
  expect(rows[0].lastActiveAt).toBe(at(12).toISOString());
  expect(rows.find((r) => r.email === "new@x.com")).toMatchObject({ name: "New Person", userId: "u2", sessionCount: 0 });
  expect(rows.find((r) => r.email === "invited@x.com")).toMatchObject({ name: "invited@x.com", userId: null, scenarioCount: 1 });
  expect(rows.find((r) => r.email === "member@x.com")).toMatchObject({ scenarioCount: 0, sessionCount: 0 });
});

test("caps runaway sessions and ignores negative durations", () => {
  const [row] = summarizeLearners({
    assignments: [],
    sessions: [
      { agentId: "a1", user: harini, startedAt: at(0), endedAt: at(9), createdAt: at(0) },
      { agentId: "a1", user: harini, startedAt: at(10), endedAt: at(9), createdAt: at(10) },
    ],
    members: [],
    users: [],
  });
  expect(row.practiceSeconds).toBe(3 * 60 * 60);
});

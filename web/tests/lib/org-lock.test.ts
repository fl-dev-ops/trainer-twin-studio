import { beforeEach, expect, mock, test } from "bun:test";

type Member = { organizationId: string; createdAt: Date; user: { email: string } };
type Assignment = { orgId: string; assignedAt: Date; recipientEmail: string; status: string };
type Session = { orgId: string; createdAt: Date; user: { email: string } };
type TwinAssignment = { orgId: string; createdAt: Date; recipientEmail: string; status: string };
let members: Member[] = [];
let assignments: Assignment[] = [];
let sessions: Session[] = [];
let twinAssignments: TwinAssignment[] = [];
const users: Record<string, { email: string }> = { u1: { email: "Asha@Example.com" } };

const inEmails = (email: string, where: { in: string[] }) => where.in.includes(email); // exact, like Postgres
mock.module("@/lib/db", () => ({
  db: {
    member: { findMany: async ({ where }: { where: { user: { email: { in: string[] } } } }) =>
      members.filter((m) => inEmails(m.user.email, where.user.email)) },
    rolePlayAssignment: { findMany: async ({ where }: { where: { recipientEmail: { in: string[] }; status: { in: string[] } } }) =>
      assignments.filter((a) => inEmails(a.recipientEmail, where.recipientEmail) && where.status.in.includes(a.status)) },
    twinAssignment: { findMany: async ({ where }: { where: { recipientEmail: { in: string[] }; status: string } }) =>
      twinAssignments.filter((t) => inEmails(t.recipientEmail, where.recipientEmail) && t.status === where.status) },
    interviewSession: { findMany: async ({ where }: { where: { user: { email: { in: string[] } } } }) =>
      sessions.filter((s) => inEmails(s.user.email, where.user.email)) },
    user: { findUnique: async ({ where }: { where: { id: string } }) => users[where.id] ?? null },
  },
}));

const { assertUserInOrg, belongsToOtherOrg, homeOrgsByEmail, OrgLockError } = await import("@/lib/org-lock");
const day = (n: number) => new Date(2026, 0, n);

beforeEach(() => { members = []; assignments = []; sessions = []; twinAssignments = []; });

test("a new person is free to join any org", async () => {
  expect(await belongsToOtherOrg("new@example.com", "orgA")).toBe(false);
  expect((await homeOrgsByEmail(["new@example.com"])).size).toBe(0);
});

test("home org is the earliest binding across memberships, assignments and sessions", async () => {
  assignments = [{ orgId: "orgB", assignedAt: day(5), recipientEmail: "asha@example.com", status: "used" }];
  sessions = [{ orgId: "orgA", createdAt: day(2), user: { email: "asha@example.com" } }];
  members = [{ organizationId: "orgC", createdAt: day(9), user: { email: "asha@example.com" } }];
  expect((await homeOrgsByEmail(["ASHA@example.com"])).get("asha@example.com")).toBe("orgA");
  expect(await belongsToOtherOrg("asha@example.com", "orgA")).toBe(false);
  expect(await belongsToOtherOrg("asha@example.com", "orgB")).toBe(true);
});

test("cancelled or expired assignments never bind a learner", async () => {
  assignments = [
    { orgId: "orgB", assignedAt: day(1), recipientEmail: "asha@example.com", status: "cancelled" },
    { orgId: "orgB", assignedAt: day(2), recipientEmail: "asha@example.com", status: "expired" },
  ];
  expect(await belongsToOtherOrg("asha@example.com", "orgA")).toBe(false);
});

test("session activation is blocked for a learner bound to another org", async () => {
  assignments = [{ orgId: "orgA", assignedAt: day(1), recipientEmail: "asha@example.com", status: "pending" }];
  await assertUserInOrg("u1", "orgA");
  await expect(assertUserInOrg("u1", "orgB")).rejects.toBeInstanceOf(OrgLockError);
});

test("an active twin assignment binds the home org; a revoked one does not", async () => {
  twinAssignments = [
    { orgId: "orgT", createdAt: day(1), recipientEmail: "asha@example.com", status: "revoked" },
    { orgId: "orgU", createdAt: day(3), recipientEmail: "asha@example.com", status: "active" },
  ];
  assignments = [{ orgId: "orgB", assignedAt: day(5), recipientEmail: "asha@example.com", status: "pending" }];
  expect((await homeOrgsByEmail(["asha@example.com"])).get("asha@example.com")).toBe("orgU");
});


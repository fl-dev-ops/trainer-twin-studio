import { beforeEach, expect, mock, test } from "bun:test";

// Org membership rules: one admin per org, and members are disabled (never deleted). Disabling signs the person
// out, revokes their twin / role-play access and ends their open sessions; their history stays.

type Row = { id: string; userId: string; role: string; disabledAt: Date | null; user: { email: string } };
let members: Row[] = [];
let calls: [string, unknown][] = [];
let closed: string[] = [];
const op = (name: string) => async (args: unknown) => (calls.push([name, args]), { count: 1 });

mock.module("@/lib/db", () => ({
  db: {
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    member: {
      findFirst: async ({ where }: { where: { id?: string; userId?: string; disabledAt?: unknown } }) =>
        members.find((m) => (where.id ? m.id === where.id : m.userId === where.userId && (where.disabledAt ? m.disabledAt : true))) ?? null,
      count: async ({ where }: { where: { role: string } }) => members.filter((m) => m.role === where.role).length,
      update: op("member.update"),
    },
    session: { deleteMany: op("session.deleteMany") },
    twinAssignment: { updateMany: op("twinAssignment.updateMany") },
    rolePlayAssignment: { updateMany: op("rolePlayAssignment.updateMany") },
    interviewSession: {
      updateMany: op("interviewSession.updateMany"),
      findMany: async () => [{ id: "live-1" }],
    },
  },
}));
mock.module("@/lib/session-lifecycle", () => ({ closeInterviewSession: async (id: string) => void closed.push(id) }));

const { assertNoSecondAdmin, isDisabledUser, MemberError, setMemberDisabled } = await import("@/lib/members");

const base = { orgId: "org", actorUserId: "u-admin" };
beforeEach(() => {
  members = [
    { id: "m-admin", userId: "u-admin", role: "admin", disabledAt: null, user: { email: "boss@acme.test" } },
    { id: "m-learner", userId: "u-learner", role: "user", disabledAt: null, user: { email: "Lee@Acme.test" } },
  ];
  calls = [];
  closed = [];
});

test("one admin: inviting, adding or promoting a second admin is refused; team and user are fine", async () => {
  await expect(assertNoSecondAdmin("admin", "org")).rejects.toThrow(/exactly one admin/);
  await expect(assertNoSecondAdmin("team,admin", "org")).rejects.toThrow(/exactly one admin/);
  await assertNoSecondAdmin("team", "org");
  await assertNoSecondAdmin("user", "org");
  members = members.filter((m) => m.role !== "admin");
  await assertNoSecondAdmin("admin", "org"); // an org without one (new org) may get its admin
});

test("the admin and yourself cannot be disabled", async () => {
  await expect(setMemberDisabled({ ...base, memberId: "m-admin", disabled: true })).rejects.toBeInstanceOf(MemberError);
  await expect(setMemberDisabled({ ...base, actorUserId: "u-learner", memberId: "m-learner", disabled: true })).rejects.toThrow(/yourself/);
  await expect(setMemberDisabled({ ...base, memberId: "nobody", disabled: true })).rejects.toThrow(/not found/);
  expect(calls).toEqual([]);
});

test("disabling signs out, revokes access, ends open sessions and keeps history (nothing is deleted)", async () => {
  await setMemberDisabled({ ...base, memberId: "m-learner", disabled: true });
  const names = calls.map(([name]) => name);
  expect(names).toEqual(["member.update", "session.deleteMany", "twinAssignment.updateMany", "rolePlayAssignment.updateMany", "interviewSession.updateMany"]);
  expect(calls[0][1]).toMatchObject({ where: { id: "m-learner" }, data: { disabledAt: expect.any(Date) } });
  expect(calls[1][1]).toEqual({ where: { userId: "u-learner" } }); // auth sessions only
  expect(calls[2][1]).toMatchObject({ where: { orgId: "org", status: "active", OR: [{ userId: "u-learner" }, { recipientEmail: "lee@acme.test" }] }, data: { status: "revoked" } });
  expect(calls[3][1]).toMatchObject({ where: { status: "pending", OR: [{ memberId: "m-learner" }, { recipientEmail: "lee@acme.test" }] }, data: { status: "cancelled" } });
  expect(calls[4][1]).toMatchObject({ where: { userId: "u-learner", status: "assigned" }, data: { status: "revoked" } });
  expect(closed).toEqual(["live-1"]);
});

test("re-enabling only clears disabledAt", async () => {
  members[1].disabledAt = new Date();
  expect(await isDisabledUser("u-learner")).toBe(true);
  await setMemberDisabled({ ...base, memberId: "m-learner", disabled: false });
  expect(calls).toEqual([["member.update", { where: { id: "m-learner" }, data: { disabledAt: null } }]]);
});

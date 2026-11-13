import { beforeEach, expect, mock, test } from "bun:test";
import { AppError } from "@/lib/errors";

type Where = { organizationId?: string; id?: string; userId?: string; user?: { email: { equals: string } } };
type Row = { id: string; userId: string; organizationId: string; role: string; disabledAt: Date | null; createdAt: Date; user: { id: string; name: string; email: string; image: null } };
let members: Row[] = [];
let calls: [string, unknown][] = [];
let closed: [string, string][] = [];
let open = ["live-1"];
let failing = new Set<string>();
let locks: string[][] = [];
const op = (name: string) => async (args: unknown) => (calls.push([name, args]), { count: 1 });
const db = {
  member: {
    findFirst: async ({ where }: { where: Where }) => members.find((m) => m.organizationId === where.organizationId && (!where.id || m.id === where.id) && (!where.userId || m.userId === where.userId) && (!where.user || m.user.email.toLowerCase() === where.user.email.equals)) ?? null,
    findMany: async ({ where }: { where: Where }) => members.filter((m) => !where.userId || m.userId === where.userId),
    count: async ({ where }: { where: { userId: string; id?: { not: string } } }) => members.filter((m) => m.userId === where.userId && !m.disabledAt && m.id !== where.id?.not).length,
    update: async (args: { where: { id: string }; data: Partial<Row> }) => { calls.push(["member.update", args]); return Object.assign(members.find((m) => m.id === args.where.id)!, args.data); },
  },
  session: { deleteMany: op("session.deleteMany") },
  twinAssignment: { updateMany: op("twinAssignment.updateMany"), deleteMany: op("twinAssignment.deleteMany") },
  rolePlayAssignment: { updateMany: op("rolePlayAssignment.updateMany"), deleteMany: op("rolePlayAssignment.deleteMany") },
  interviewSession: { updateMany: op("interviewSession.updateMany"), findMany: async ({ where }: { where: { endWorkAt?: null } }) => where.endWorkAt === null ? [] : open.map((id) => ({ id })) },
};
mock.module("@/lib/db", () => ({ db, withLock: async (keys: string[], work: (tx: typeof db) => Promise<unknown>) => { locks.push(keys); return work(db); } }));
mock.module("@/lib/session-lifecycle", () => ({ closeInterviewSession: async (id: string, status: string) => {
  closed.push([id, status]);
  if (failing.has(id)) throw new Error(`Could not end ${id}`);
  open = open.filter((call) => call !== id);
  return { id, finalStatus: status };
} }));
const { assertNotDisabledIn, changeMemberRole, isDisabledUser, setMemberDisabled } = await import("@/lib/members");
const base = { orgId: "org", actorUserId: "u-admin" };
const disable = (memberId = "m-learner", disabled = true) => setMemberDisabled({ ...base, memberId, disabled });
beforeEach(() => {
  members = [["admin", "Boss", "boss@acme.test"], ["learner", "Lee", "Lee@Acme.test"]].map(([id, name, email]) => ({ id: `m-${id}`, userId: `u-${id}`, organizationId: "org", role: id === "admin" ? "admin" : "user", disabledAt: null, createdAt: new Date(0), user: { id: `u-${id}`, name, email, image: null } }));
  calls = []; closed = []; open = ["live-1"]; failing = new Set(); locks = [];
});

test("refuses admin_fixed when disabling or changing the admin, with no writes", async () => {
  for (const run of [() => disable("m-admin"), () => changeMemberRole({ orgId: "org", email: "boss@acme.test", role: "team" }), () => changeMemberRole({ orgId: "org", email: "lee@acme.test", role: "admin" as never })]) {
    const error = await run().catch((error) => error);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 403, code: "admin_fixed", message: "The admin's role can't be changed and the admin can't be disabled." });
    expect(calls).toEqual([]);
  }
});
test("refuses self_disable with no writes", async () => {
  await expect(setMemberDisabled({ ...base, actorUserId: "u-learner", memberId: "m-learner", disabled: true })).rejects.toMatchObject({ status: 400, code: "self_disable", message: "You can't disable yourself." });
  expect(calls).toEqual([]);
});
test("refuses not_found for an unknown member or role-change email with no writes", async () => {
  for (const run of [() => disable("missing"), () => changeMemberRole({ orgId: "org", email: "missing@acme.test", role: "team" })]) await expect(run()).rejects.toMatchObject({ status: 404, code: "not_found", message: "Not found." });
  expect(calls).toEqual([]);
});
test("disabling signs out, revokes only active access, ends running calls, and keeps history under the people lock", async () => {
  await disable();
  expect(locks).toEqual([["people:org"]]);
  expect(calls.map(([name]) => name)).toEqual(["member.update", "session.deleteMany", "twinAssignment.updateMany", "rolePlayAssignment.updateMany", "interviewSession.updateMany"]);
  expect(calls[1][1]).toEqual({ where: { userId: "u-learner" } });
  expect(calls[2][1]).toMatchObject({ where: { orgId: "org", status: "active", userId: "u-learner" }, data: { status: "revoked" } });
  expect(calls[3][1]).toMatchObject({ where: { orgId: "org", status: { in: ["pending", "used"] }, memberId: "m-learner" }, data: { status: "cancelled" } });
  expect(calls[4][1]).toMatchObject({ where: { userId: "u-learner", status: "assigned" }, data: { status: "revoked", runtimeTokenHash: null } });
  expect(closed).toEqual([["live-1", "abandoned"]]);
});
test("disable then re-enable restores membership only, not assignments", async () => {
  await disable(); calls = [];
  expect(await isDisabledUser("u-learner")).toBe(true);
  await disable("m-learner", false);
  expect(calls).toEqual([["member.update", { where: { id: "m-learner" }, data: { disabledAt: null } }]]);
  expect(await isDisabledUser("u-learner")).toBe(false);
  calls = []; await disable("m-learner", false); expect(calls).toEqual([]);
});
test("refuses calls_not_ended while repeat disable retries and one failing call never prevents the others", async () => {
  open = ["broken", "healthy"]; failing.add("broken");
  await expect(disable()).rejects.toMatchObject({ code: "calls_not_ended", status: 500, message: "Disabled, but 1 call(s) in progress could not be ended yet. Disable again to retry." });
  expect(closed).toEqual([["broken", "abandoned"], ["healthy", "abandoned"]]);
  expect(members[1].disabledAt).not.toBeNull();
  calls = []; failing.clear();
  await disable();
  expect(calls).toEqual([]);
  expect(closed).toEqual([["broken", "abandoned"], ["healthy", "abandoned"], ["broken", "abandoned"]]);
});
test("team ↔ learner role changes drop assignments in the same locked transaction, preserving other orgs", async () => {
  expect(await changeMemberRole({ orgId: "org", email: " LEE@ACME.TEST ", role: "team" })).toEqual({ before: "user", after: "team" });
  expect(calls.map(([name]) => name)).toEqual(["member.update", "twinAssignment.deleteMany", "rolePlayAssignment.deleteMany"]);
  expect(calls.slice(1)).toEqual([["twinAssignment.deleteMany", { where: { orgId: "org", userId: "u-learner" } }], ["rolePlayAssignment.deleteMany", { where: { orgId: "org", memberId: "m-learner" } }]]);
  calls = [];
  expect(await changeMemberRole({ orgId: "org", email: "lee@acme.test", role: "user" })).toEqual({ before: "team", after: "user" });
  expect(calls.map(([name]) => name)).toEqual(["member.update"]);
  expect(locks).toEqual([["people:org"], ["people:org"]]);
});
test("refuses member_disabled in its org while another enabled membership keeps sign-in working", async () => {
  members.push({ ...members[1], id: "m-other", organizationId: "other" });
  await disable();
  expect(calls.map(([name]) => name)).not.toContain("session.deleteMany");
  expect(await isDisabledUser("u-learner")).toBe(false);
  await expect(assertNotDisabledIn("u-learner", "org")).rejects.toMatchObject({ status: 403, code: "member_disabled", message: "Your access to this organization has been turned off. Ask its admin to turn it back on." });
  await assertNotDisabledIn("u-learner", "other");
  members[2].disabledAt = new Date();
  expect(await isDisabledUser("u-learner")).toBe(true);
  expect(await isDisabledUser("unknown")).toBe(false);
});

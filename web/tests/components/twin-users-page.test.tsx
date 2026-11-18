import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TwinUsersPage } from "@/components/twin/twin-users-page";

const groupBy = mock(async () => [{ userId: "active", _count: 250 }]);
const assignments = mock(async () => [
  { userId: "active", accessUntil: null },
  { userId: "active", accessUntil: null },
  { userId: "idle", accessUntil: null },
  { userId: "disabled", accessUntil: null },
]);
mock.module("@/lib/db", () => ({
  withLock: async () => { throw new Error("Unexpected write in read-only fixture"); },
  isUniqueViolation: () => false,
  db: {
    twinAssignment: { findMany: assignments },
    interviewSession: { groupBy },
  },
}));
const people = await import("@/lib/org-people");
const minutes = await import("@/lib/minutes");
const { twinRouter } = await import("@/lib/twin/trpc");
const peopleSpy = spyOn(people, "orgPeople").mockResolvedValue(["active", "idle"].map((id) => ({
  memberId: `member-${id}`, userId: id, name: id, email: `${id}@example.com`, image: null,
  role: "user", disabled: false, disabledAt: null, addedAt: new Date(),
})));
const minutesSpy = spyOn(minutes, "learnerMinutes").mockResolvedValue(new Map());
afterAll(() => { peopleSpy.mockRestore(); minutesSpy.mockRestore(); });

const caller = twinRouter.createCaller({ user: {
  id: "admin", name: "Admin", email: "admin@example.com", orgId: "org", orgSlug: "acme", role: "admin",
} });

test("twin users include all-time session counts once per learner and zero for idle learners", async () => {
  const rows = await caller.users.list();
  expect(rows).toMatchObject([
    { userId: "active", agents: 2, sessions: 250 },
    { userId: "idle", agents: 1, sessions: 0 },
  ]);
  expect(rows).toHaveLength(2);
  expect(groupBy).toHaveBeenCalledWith({
    by: ["userId"],
    where: {
      orgId: "org", deletedAt: null, startedAt: { not: null }, status: { not: "failed" },
      twinCalibration: { is: null }, agent: { kind: "TWIN" },
      user: { members: { some: { organizationId: "org", role: "user" } } },
    },
    _count: true,
  });
  expect(peopleSpy).toHaveBeenCalledWith("org", { roles: ["user"] });
  expect(assignments).toHaveBeenCalledWith({
    where: { orgId: "org", status: "active" }, select: { userId: true, accessUntil: true },
  });
});

test("twin users table renders the Sessions column, including zero counts", async () => {
  const html = renderToStaticMarkup(<TwinUsersPage learners={await caller.users.list()} />);
  expect(html).toContain(">Sessions</span>");
  expect(html).toContain('<span class="tabular-nums">250</span>');
  expect(html).toContain('<span class="tabular-nums">0</span>');
  expect(html).toContain('href="/users/active"');
  expect(html).toContain("overflow-x-auto");
});

test("twin users table keeps its empty state", () => {
  const html = renderToStaticMarkup(<TwinUsersPage learners={[]} />);
  expect(html).toContain(">Sessions</span>");
  expect(html).toContain("Nobody has twin access yet.");
});

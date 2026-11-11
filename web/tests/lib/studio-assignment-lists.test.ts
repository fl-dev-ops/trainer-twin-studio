import { beforeEach, expect, mock, test } from "bun:test";

// Simulate stale pre-migration rows without planting invalid studio assignments in the shared DB.
const members = ["admin", "team", "user", "user"].map((role, index) => ({
  id: `member-${index}`, role, createdAt: new Date(0), disabledAt: index === 3 ? new Date(0) : null,
  user: { id: `user-${index}`, name: `Person ${index}`, email: `person-${index}@example.com`, image: null },
}));
let noLearners = false;
const people = mock(async ({ where }: any) => members.filter((member) =>
  (!noLearners || member.role !== "user") && (!where.role || where.role.in.includes(member.role))
  && (!where.id || where.id.in.includes(member.id)) && (where.disabledAt !== null || member.disabledAt === null)));
const twins = mock(async ({ where }: any) => members
  .filter((member) => !where.userId || where.userId.in.includes(member.user.id))
  .map((member) => ({ id: `twin-${member.id}`, status: "active", accessUntil: null, shareCode: member.id,
    shareLinkId: null, createdAt: new Date(0), user: member.user })));
const assignments = members.map((member) => ({ id: `rp-${member.id}`, memberId: member.id, status: "pending",
  assignedAt: new Date(0), expiresAt: new Date(), deployment: { agentId: "agent" } }));
const agent = { id: "agent", slug: "scenario", name: "Scenario", kind: "ROLEPLAY", data: {}, version: 1,
  visibility: "private", order: 0, updatedAt: new Date(0), persona: { name: "Persona", data: {} } };
mock.module("@/lib/db", () => ({
  withLock: async () => { throw new Error("Unexpected locked write in read-only fixture"); },
  isUniqueViolation: (error: any) => error?.code === "P2002", db: {
  member: { findMany: people }, twinAssignment: { findMany: twins },
  rolePlayAssignment: { findMany: async () => assignments },
  agent: { findMany: async () => [agent] }, specDraft: { findMany: async () => [] },
  interviewSession: { groupBy: async () => [] },
} }));
const realMinutes = await import("@/lib/minutes");
mock.module("@/lib/minutes", () => ({ ...realMinutes, learnerMinutes: async (_orgId: string, emails: string[]) => new Map(emails.map((email) => [email, { givenSeconds: 1800, usedSeconds: 0, leftSeconds: 1800 }])) }));
const { listTwinAssignments } = await import("@/lib/twin-access");
const { roleplayRouter } = await import("@/lib/roleplay/trpc");
const { listSpecSummaries } = await import("@/lib/specs");
const learners = ["person-2@example.com", "person-3@example.com"];
beforeEach(() => { noLearners = false; people.mockClear(); twins.mockClear(); });

test("listTwinAssignments excludes admin/team even with stale assignments, and retains disabled learners", async () => {
  expect((await listTwinAssignments("org", "agent")).map((row) => row.email)).toEqual(learners);
  expect(people.mock.calls[0][0].where).toMatchObject({ organizationId: "org", role: { in: ["user"] } });
  expect(twins.mock.calls[0][0].where).toEqual({ orgId: "org", agentId: "agent", userId: { in: ["user-2", "user-3"] } });
});

test("listTwinAssignments with no learners never returns studio assignments", async () => {
  noLearners = true;
  expect(await listTwinAssignments("org", "agent")).toEqual([]);
  expect(twins.mock.calls[0][0].where.userId).toEqual({ in: [] });
});

test("invitesFor through scenarios.list excludes admin/team with stale assignments, retaining disabled learners", async () => {
  const caller = roleplayRouter.createCaller({ user: { id: "trainer", name: "Trainer", email: "trainer@example.com", orgId: "org", orgSlug: "org", role: "admin" } });
  expect((await caller.scenarios.list())[0].learners.map((row) => row.email)).toEqual(learners);
  expect(people.mock.calls[0][0].where).toMatchObject({ organizationId: "org", role: { in: ["user"] } });
});

test("listSpecSummaries learnersByAgent excludes admin/team with stale assignments, retaining disabled learners", async () => {
  expect((await listSpecSummaries("agents", "org"))[0].learners.map((row) => row.email)).toEqual(learners);
  expect(people.mock.calls[0][0].where).toMatchObject({ organizationId: "org", role: { in: ["user"] } });
});

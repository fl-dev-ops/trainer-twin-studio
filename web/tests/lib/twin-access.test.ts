import { beforeEach, expect, mock, test } from "bun:test";

type Assignment = { id: string; orgId: string; agentId: string; minutesLimit: number; status: string; userId: string | null; recipientEmail: string; shareCode: string; shareLinkId?: string | null };
type Link = { id: string; orgId: string; agentId: string; code: string; minutesPerUser: number; status: string };
let assignments: Assignment[] = [];
let links: Link[] = [];
let usedSeconds: Record<string, number> = {};
let created = 0;

mock.module("@/lib/db", () => ({
  db: {
    twinAssignment: {
      findUnique: async ({ where }: { where: { shareCode?: string; agentId_recipientEmail?: { agentId: string; recipientEmail: string } } }) =>
        assignments.find((a) => where.shareCode
          ? a.shareCode === where.shareCode
          : a.agentId === where.agentId_recipientEmail!.agentId && a.recipientEmail === where.agentId_recipientEmail!.recipientEmail) ?? null,
      findFirst: async ({ where }: { where: { orgId: string; agentId: string; OR: [{ userId: string }, { userId: null; recipientEmail: string }] } }) =>
        assignments.find((a) => a.orgId === where.orgId && a.agentId === where.agentId
          && (a.userId === where.OR[0].userId || (a.userId === null && a.recipientEmail === where.OR[1].recipientEmail))) ?? null,
      create: async ({ data }: { data: Omit<Assignment, "id" | "status"> }) => {
        created++;
        const row = { id: `new${created}`, status: "active", ...data } as Assignment;
        assignments.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Assignment> }) =>
        Object.assign(assignments.find((a) => a.id === where.id)!, data),
    },
    twinShareLink: { findUnique: async ({ where }: { where: { code: string } }) => links.find((l) => l.code === where.code) ?? null },
    $queryRaw: async (_strings: TemplateStringsArray, id: string) => [{ seconds: usedSeconds[id] ?? 0 }],
  },
}));

const { twinAccessByAgent, twinAccessByCode, TwinAccessError } = await import("@/lib/twin-access");
const learner = { id: "u1", email: "Learner@Example.com" };

beforeEach(() => {
  assignments = [{ id: "a1", orgId: "org", agentId: "twin", minutesLimit: 30, status: "active", userId: null, recipientEmail: "learner@example.com", shareCode: "personal" }];
  links = [{ id: "l1", orgId: "org", agentId: "twin2", code: "common", minutesPerUser: 20, status: "active" }];
  usedSeconds = {};
  created = 0;
});

const rejects = async (promise: Promise<unknown>, status: number, message: string) => {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(TwinAccessError);
  expect(error).toMatchObject({ status, message });
};

test("a code that is not a twin code is not handled here", async () => {
  expect(await twinAccessByCode({ orgId: "org", user: learner, code: "nope", join: true })).toBeNull();
});

test("personal code: minutes left, and the user is bound on first use", async () => {
  usedSeconds.a1 = 600;
  expect(await twinAccessByCode({ orgId: "org", user: learner, code: "personal", join: true }))
    .toEqual({ assignmentId: "a1", agentId: "twin", secondsLeft: 1200 });
  expect(assignments[0].userId).toBe("u1");
});

test("personal code: wrong person, other org, revoked and used-up are refused", async () => {
  await rejects(twinAccessByCode({ orgId: "org", user: { id: "u2", email: "other@example.com" }, code: "personal", join: true }), 403, "This twin is not assigned to your account");
  await rejects(twinAccessByCode({ orgId: "other", user: learner, code: "personal", join: true }), 403, "This twin link belongs to another organization");
  assignments[0].status = "revoked";
  await rejects(twinAccessByCode({ orgId: "org", user: learner, code: "personal", join: true }), 403, "Your access to this twin was removed");
  assignments[0].status = "active";
  usedSeconds.a1 = 30 * 60;
  await rejects(twinAccessByCode({ orgId: "org", user: learner, code: "personal", join: true }), 403, "You have used all your minutes with this twin");
});

test("common link: preview creates nothing; joining creates one assignment with the link's minutes", async () => {
  expect(await twinAccessByCode({ orgId: "org", user: learner, code: "common", join: false }))
    .toEqual({ assignmentId: null, agentId: "twin2", secondsLeft: 1200 });
  expect(created).toBe(0);
  const joined = await twinAccessByCode({ orgId: "org", user: learner, code: "common", join: true });
  expect(joined).toMatchObject({ agentId: "twin2", secondsLeft: 1200 });
  expect(assignments.at(-1)).toMatchObject({ agentId: "twin2", recipientEmail: "learner@example.com", userId: "u1", minutesLimit: 20, shareLinkId: "l1" });
  // Opening the link again reuses the same assignment and never adds minutes.
  usedSeconds[joined!.assignmentId!] = 15 * 60;
  expect(await twinAccessByCode({ orgId: "org", user: learner, code: "common", join: true })).toMatchObject({ assignmentId: joined!.assignmentId, secondsLeft: 300 });
  expect(created).toBe(1);
});

test("common link: a disabled link refuses new joins", async () => {
  links[0].status = "disabled";
  await rejects(twinAccessByCode({ orgId: "org", user: learner, code: "common", join: true }), 403, "This twin link is no longer active");
  expect(created).toBe(0);
});

test("direct start needs the user's own assignment on that twin", async () => {
  expect(await twinAccessByAgent({ orgId: "org", user: learner, agentId: "twin" })).toMatchObject({ assignmentId: "a1", secondsLeft: 1800 });
  await rejects(twinAccessByAgent({ orgId: "org", user: learner, agentId: "twin2" }), 403, "This twin is not assigned to your account");
});

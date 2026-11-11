import { beforeEach, expect, mock, test } from "bun:test";

type Row = { id: string; orgId: string; agentId: string; minutesLimit: number; status: string; userId: string; accessUntil: Date | null };
let assignment: Row;

mock.module("@/lib/db", () => ({
  withLock: async () => { throw new Error("Unexpected locked write in read-only fixture"); },
  isUniqueViolation: (error: any) => error?.code === "P2002",
  db: {
    twinAssignment: { findUnique: async () => assignment, update: async () => assignment },
    twinShareLink: { findUnique: async () => null },
  },
}));

const { accessUntilSchema, twinAccessByCode } = await import("@/lib/twin-access");
const start = () => twinAccessByCode({ orgId: "org1", user: { id: "u1", email: "ana@x.com" }, code: "c1", join: true });
const day = 24 * 60 * 60 * 1000;

beforeEach(() => {
  assignment = { id: "a1", orgId: "org1", agentId: "t1", minutesLimit: 30, status: "active", userId: "u1", accessUntil: null };
});

test("no end date: the learner can start", async () => {
  expect(await start()).toEqual({ assignmentId: "a1", agentId: "t1" });
});

test("within the end date the learner can start; past it they can't, and are told it ended", async () => {
  assignment.accessUntil = new Date(Date.now() + day);
  expect((await start())?.assignmentId).toBe("a1");
  assignment.accessUntil = new Date(Date.now() - 1000);
  expect(start()).rejects.toThrow("Your access to this twin has ended");
});

test("the end date when assigning: optional, but never in the past", () => {
  expect(accessUntilSchema.parse(undefined)).toBeUndefined();
  expect(accessUntilSchema.parse(null)).toBeNull();
  expect(accessUntilSchema.safeParse(new Date(Date.now() + day).toISOString()).success).toBe(true);
  expect(accessUntilSchema.safeParse(new Date(Date.now() - day).toISOString()).success).toBe(false);
});

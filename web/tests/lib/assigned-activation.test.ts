import { expect, mock, test } from "bun:test";

let status = "used";
let deploymentStatus = "active";
let existing: { id: string; status: string; userId: string; agentSlug: string; mode: string; activationKey: string; allowedSeconds: number; startedAt: Date } | null = null;
let updatedStatus = "";

mock.module("@/lib/db", () => ({
  withLock: async () => { throw new Error("Unexpected locked write in read-only fixture"); },
  isUniqueViolation: (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "P2002", db: {
  rolePlayAssignment: {
    findFirst: async () => ({
      id: "assignment", memberId: "member", member: { userId: "learner" }, status,
      expiresAt: new Date(0), shareCode: "link",
      deployment: { id: "deployment", status: deploymentStatus, allowedModes: "voice", agent: { id: "agent" } },
    }),
    update: async ({ data }: { data: { status: string } }) => { updatedStatus = data.status; },
    findMany: async () => [],
  },
  interviewSession: {
    findFirst: async () => existing,
    findUnique: async () => existing,
    findMany: async () => [],
    update: async () => ({}),
  },
  twinAssignment: { findMany: async () => [] },
  user: { findUnique: async () => ({ email: "learner@example.com" }) },
  member: { findMany: async () => [], findFirst: async ({ where }: { where: { userId: string } }) => where.userId === "learner" ? { id: "member", role: "user", disabledAt: null, createdAt: new Date(0), user: { id: "learner", name: "Learner", email: "learner@example.com", image: null } } : null },
} }));

const { activateSession } = await import("../../lib/interview-sessions");
const input = { orgId: "org", userId: "learner", userEmail: "learner@example.com", shareCode: "link" };

test.each(["activating", "active"])("used assignments with a past expiry resume their %s session with its remaining seconds", async (sessionStatus) => {
  status = "used";
  existing = { id: "session", status: sessionStatus, userId: "learner", agentSlug: "agent", mode: "voice", activationKey: "assignment:assignment:original", allowedSeconds: 120, startedAt: new Date(Date.now() - 30_000) };
  const previousSecret = process.env.COPILOT_SERVICE_SECRET;
  process.env.COPILOT_SERVICE_SECRET = "test-only-secret";
  try {
    const resumed = await activateSession(input);
    expect(resumed).toMatchObject({ id: "session", status: sessionStatus });
    expect(resumed?.secondsLeft).toBeGreaterThanOrEqual(89);
    expect(resumed?.secondsLeft).toBeLessThanOrEqual(90);
    expect(resumed?.runtimeToken).toBeTruthy();
  } finally {
    if (previousSecret === undefined) delete process.env.COPILOT_SERVICE_SECRET;
    else process.env.COPILOT_SERVICE_SECRET = previousSecret;
    existing = null;
  }
});

test("inactive deployments, expired/cancelled statuses and mismatched assignments still cannot activate", async () => {
  deploymentStatus = "disabled";
  expect(await activateSession(input)).toBeNull();
  deploymentStatus = "active";
  status = "expired";
  expect(await activateSession(input)).toBeNull();
  status = "pending";
  await expect(activateSession({ ...input, userId: "outsider" })).rejects.toMatchObject({ code: "no_org", status: 403 });
  status = "cancelled";
  expect(await activateSession(input)).toBeNull();
  expect(updatedStatus).toBe("");
});

import { expect, mock, test } from "bun:test";

let status = "used";
let deploymentStatus = "active";
let existing: { id: string; status: string; userId: string; agentSlug: string; mode: string } | null = null;
let updatedStatus = "";

mock.module("@/lib/db", () => ({ db: {
  rolePlayAssignment: {
    findFirst: async () => ({
      id: "assignment", memberId: null, recipientEmail: "learner@example.com", status,
      expiresAt: new Date(Date.now() + 60_000), shareCode: "link",
      deployment: { id: "deployment", status: deploymentStatus, allowedModes: "voice", agent: { id: "agent" } },
    }),
    update: async ({ data }: { data: { status: string } }) => { updatedStatus = data.status; },
  },
  interviewSession: {
    findUnique: async () => existing,
    update: async () => ({}),
  },
} }));

const { activateSession } = await import("../../lib/interview-sessions");
const input = { orgId: "org", userId: "learner", userEmail: "learner@example.com", shareCode: "link" };

test("used assignments cannot start another session but can resume their active one", async () => {
  expect(await activateSession(input)).toBeNull();
  existing = { id: "session", status: "active", userId: "learner", agentSlug: "agent", mode: "voice" };
  const previousSecret = process.env.COPILOT_SERVICE_SECRET;
  process.env.COPILOT_SERVICE_SECRET = "test-only-secret";
  try {
    const resumed = await activateSession(input);
    expect(resumed).toMatchObject({ id: "session", status: "active" });
    expect(resumed?.runtimeToken).toBeTruthy();
  } finally {
    if (previousSecret === undefined) delete process.env.COPILOT_SERVICE_SECRET;
    else process.env.COPILOT_SERVICE_SECRET = previousSecret;
    existing = null;
  }
});

test("inactive deployments, expired and mismatched assignments cannot activate", async () => {
  deploymentStatus = "disabled";
  expect(await activateSession(input)).toBeNull();
  deploymentStatus = "active";
  status = "expired";
  expect(await activateSession(input)).toBeNull();
  status = "pending";
  expect(await activateSession({ ...input, userEmail: "outsider@example.com" })).toBeNull();
  status = "cancelled";
  expect(await activateSession(input)).toBeNull();
  expect(updatedStatus).toBe("");
});

import { expect, mock, test } from "bun:test";

const user = { id: "learner", email: "harini@foreverlearning.in" };
let member = false;
const assignment = {
  shareCode: "practice-code",
  orgId: "demo",
  status: "pending",
  expiresAt: new Date(Date.now() + 60_000),
  deploymentActive: true,
  recipientEmail: user.email,
  member: null as { userId: string } | null,
  sessions: [] as { id: string }[],
};
let saved = 0;

mock.module("@/lib/session-user", () => ({
  resolveSessionUser: async () => ({ org: { id: "demo" }, user }),
}));
mock.module("@/lib/db", () => ({
  db: {
    member: { findFirst: async () => member ? { id: "member" } : null },
    rolePlayAssignment: {
      findFirst: async ({ where }: { where: { shareCode: string; orgId: string; status: string; expiresAt: { gt: Date }; deployment: { status: string } } }) =>
        where.shareCode === assignment.shareCode && where.orgId === assignment.orgId
        && where.status === assignment.status && assignment.expiresAt > where.expiresAt.gt
        && where.deployment.status === "active" && assignment.deploymentActive
          ? assignment : null,
    },
  },
}));
mock.module("@/lib/org", () => ({ getSessionOrg: async () => ({ id: "demo" }) }));
mock.module("@/lib/specs", () => ({
  listUploads: async () => [],
  saveUpload: async () => { saved++; return { id: "doc", name: "resume.txt", kind: "text", manifest: {} }; },
}));

const { POST } = await import("../../app/api/upload/route");

function request(code = "practice-code") {
  const form = new FormData();
  form.set("file", new File(["resume"], "resume.txt", { type: "text/plain" }));
  if (code) form.set("shareCode", code);
  return new Request("https://latencytest.trainertwin.com/api/upload", { method: "POST", body: form });
}

test("assigned learners can upload, other users and spent links cannot; members retain access", async () => {
  expect((await POST(request())).status).toBe(200);
  expect(saved).toBe(1);

  assignment.recipientEmail = "someone-else@example.com";
  expect((await POST(request())).status).toBe(403);
  assignment.recipientEmail = user.email;
  assignment.status = "used";
  expect((await POST(request())).status).toBe(403);
  assignment.status = "pending";
  assignment.deploymentActive = false;
  expect((await POST(request())).status).toBe(403);
  assignment.deploymentActive = true;
  assignment.expiresAt = new Date(0);
  expect((await POST(request())).status).toBe(403);
  assignment.expiresAt = new Date(Date.now() + 60_000);
  assignment.sessions = [{ id: "completed" }];
  expect((await POST(request())).status).toBe(403);
  assignment.sessions = [];
  assignment.member = { userId: "another-learner" };
  expect((await POST(request())).status).toBe(403);
  assignment.member = null;
  assignment.orgId = "another-org";
  expect((await POST(request())).status).toBe(403);
  assignment.orgId = "demo";
  expect((await POST(request(""))).status).toBe(403);
  expect(saved).toBe(1);

  member = true;
  expect((await POST(request(""))).status).toBe(200);
  expect(saved).toBe(2);
});

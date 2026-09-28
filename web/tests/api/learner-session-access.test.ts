import { expect, mock, test } from "bun:test";

let user = { id: "learner", email: "harini@example.com" };
let role: string | null = null;
let trainerOrg: { id: string } | null = null;
let documentWhere: Record<string, unknown> | undefined;
let sessionWhere: Record<string, unknown> | undefined;
let feedbackWhere: Record<string, unknown> | undefined;
let feedbackData: Record<string, unknown> | undefined;

mock.module("@/lib/session-user", () => ({
  resolveSessionUser: async () => ({ org: { id: "demo" }, user }),
}));
mock.module("@/lib/interview-sessions", () => ({
  authorizeRuntimeSession: async () => null,
  activateSession: async () => null,
  finalizeInterviewSession: async () => null,
}));
mock.module("@/lib/org", () => ({ getTrainerOrg: async () => trainerOrg, getSessionOrg: async () => ({ id: "demo" }) }));
mock.module("@/lib/db", () => ({
  db: {
    member: { findFirst: async () => role ? { role } : null },
    interviewSessionDocument: { findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      documentWhere = where;
      return where.documentId === "owned" ? { document: { name: "resume.pdf", mimeType: "application/pdf", content: Buffer.from("pdf") } } : null;
    } },
    interviewSession: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => { sessionWhere = where; return []; },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        sessionWhere = where;
        return { id: "session", status: "active", evidence: {}, runtimeState: {}, runtimeRevision: 0 };
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        feedbackWhere = where;
        feedbackData = data;
        return { count: where.id === "session" ? 1 : 0 };
      },
    },
  },
}));

const { GET: readDocument } = await import("../../app/api/documents/[id]/raw/route");
const { GET: readSession } = await import("../../app/api/sessions/[id]/route");
const { POST: submitFeedback } = await import("../../app/api/sessions/[id]/feedback/route");
const { GET: listSessions } = await import("../../app/api/sessions/route");
const context = (id: string) => ({ params: Promise.resolve({ id }) });

test("assigned non-member can read only documents attached to their own session", async () => {
  expect((await readDocument(new Request("https://demo.trainertwin.com/api/documents/owned/raw?sessionId=session"), context("owned"))).status).toBe(200);
  expect(documentWhere).toMatchObject({ sessionId: "session", documentId: "owned", session: { orgId: "demo", userId: "learner" } });
  expect((await readDocument(new Request("https://demo.trainertwin.com/api/documents/other/raw?sessionId=session"), context("other"))).status).toBe(404);
  expect((await readDocument(new Request("https://demo.trainertwin.com/api/documents/owned/raw"), context("owned"))).status).toBe(400);
});

test("session snapshots are scoped to the owner, except for org trainers", async () => {
  await readSession(new Request("https://demo.trainertwin.com/api/sessions/session"), context("session"));
  expect(sessionWhere).toMatchObject({ id: "session", orgId: "demo", userId: "learner" });
  role = "owner";
  user = { id: "trainer", email: "trainer@example.com" };
  await readSession(new Request("https://demo.trainertwin.com/api/sessions/session"), context("session"));
  expect(sessionWhere).toMatchObject({ id: "session", orgId: "demo" });
  expect(sessionWhere).not.toHaveProperty("userId");
  role = null;
  user = { id: "learner", email: "harini@example.com" };
});

test("organization-wide session listing is trainer-only", async () => {
  expect((await listSessions()).status).toBe(401);
  trainerOrg = { id: "demo" };
  expect((await listSessions()).status).toBe(200);
  expect(sessionWhere).toMatchObject({ orgId: "demo", deletedAt: null });
  trainerOrg = null;
});

test("only the session owner can submit valid feedback", async () => {
  const request = (rating: number) => new Request("https://demo.trainertwin.com/api/sessions/session/feedback", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rating, note: "Helpful" }),
  });
  expect((await submitFeedback(request(5), context("session"))).status).toBe(200);
  expect(feedbackWhere).toMatchObject({ id: "session", orgId: "demo", userId: "learner", status: { in: ["completed", "abandoned"] } });
  expect(feedbackData).toMatchObject({ feedbackRating: 5, feedbackNote: "Helpful" });
  expect((await submitFeedback(request(0), context("session"))).status).toBe(400);
  expect((await submitFeedback(request(5), context("other"))).status).toBe(404);
});

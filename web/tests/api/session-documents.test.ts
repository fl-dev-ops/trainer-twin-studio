import { beforeEach, expect, mock, test } from "bun:test";

type Session = { status: string; compiledSnapshot: unknown; agent: { kind: string; data: unknown } };
let session: Session | null;
let doc: { id: string; name: string; kind: string; mimeType: string; size: number; manifest: unknown } | null;
let linked: unknown[] = [];
let snapshots: unknown[] = [];

const twinOn = { twinSettings: { duringUpload: true } };

mock.module("@/lib/session-user", () => ({
  resolveSessionUser: async () => ({ org: { id: "org1" }, user: { id: "u1", email: "a@x.com" } }),
}));
mock.module("@/lib/db", () => ({
  db: {
    interviewSession: {
      findFirst: async () => session,
      update: (args: { data: { compiledSnapshot: unknown } }) => { snapshots.push(args.data.compiledSnapshot); return Promise.resolve(); },
    },
    contextDocument: { findFirst: async () => doc },
    interviewSessionDocument: { createMany: (args: { data: unknown[] }) => { linked.push(...args.data); return Promise.resolve(); } },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));

const { POST } = await import("@/app/api/sessions/[id]/documents/route");
const attach = (body: unknown = { documentId: "d1" }) =>
  POST(new Request("https://web.test/api/sessions/s1/documents", { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: "s1" }),
  });

beforeEach(() => {
  session = {
    status: "active",
    compiledSnapshot: { agent: { data: twinOn }, sessionDocumentIds: [], documentManifests: [] },
    agent: { kind: "TWIN", data: twinOn },
  };
  doc = { id: "d1", name: "brochure.pdf", kind: "document", mimeType: "application/pdf", size: 10, manifest: null };
  linked = [];
  snapshots = [];
});

test("a twin that allows it gets the file linked and listed for the runtime", async () => {
  const response = await attach();
  expect(response.status).toBe(200);
  expect(linked).toEqual([{ sessionId: "s1", documentId: "d1" }]);
  expect(snapshots).toHaveLength(1);
  expect((snapshots[0] as { sessionDocumentIds: string[] }).sessionDocumentIds).toEqual(["d1"]);
});

test("the settings pinned at session start decide, not later edits", async () => {
  session!.compiledSnapshot = { agent: { data: { twinSettings: { duringUpload: false } } } };
  expect((await attach()).status).toBe(403);
  expect(linked).toEqual([]);
});

test("role plays, ended sessions and other people's files are refused", async () => {
  session!.agent.kind = "ROLEPLAY";
  expect((await attach()).status).toBe(403);
  session!.agent.kind = "TWIN";
  session!.status = "completed";
  expect((await attach()).status).toBe(409);
  session!.status = "active";
  doc = null;
  expect((await attach()).status).toBe(404);
  expect((await attach({})).status).toBe(400);
  expect(linked).toEqual([]);
});

test("attaching the same file twice lists it once", async () => {
  session!.compiledSnapshot = { agent: { data: twinOn }, sessionDocumentIds: ["d1"], documentManifests: [{ id: "d1" }] };
  expect((await attach()).status).toBe(200);
  expect(snapshots).toEqual([]);
});

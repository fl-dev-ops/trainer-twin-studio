import { beforeEach, expect, mock, test } from "bun:test";

type Doc = { id: string; kbId: string; orgId: string; slug: string; title: string; status: string; error?: string | null; s3MarkdownKey?: string; indexedAt?: Date };
let docs: Doc[] = [];
let objects = new Map<string, string>();
let deletedPrefixes: string[] = [];
const upsert = mock(async (_orgId: string, _meta: unknown, _chunks: unknown[]) => {});
const prune = mock(async (_orgId: string, _docId: string, _keep: number) => {});
const createDb = mock(async () => ({ tenantId: "t", database: "org_org-1" }));
const prefix = "test/org-1";

mock.module("@/lib/db", () => ({
  db: {
    knowledgeDocument: {
      findFirst: async ({ where }: { where: { id: string; kbId: string; kb: { orgId: string } } }) =>
        docs.find((d) => d.id === where.id && d.kbId === where.kbId && d.orgId === where.kb.orgId) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<Doc> }) =>
        Object.assign(docs.find((d) => d.id === where.id)!, data),
    },
  },
}));
mock.module("@/lib/s3", () => ({
  orgPrefix: () => prefix,
  putObject: async (key: string, body: string) => { objects.set(key, body); },
  deletePrefix: async (p: string) => { deletedPrefixes.push(p); for (const k of objects.keys()) if (k.startsWith(p)) objects.delete(k); },
}));
mock.module("@/lib/main-collection", () => ({ MainCollectionService: { upsertKnowledgeChunks: upsert, pruneKnowledgeChunks: prune } }));
mock.module("@/lib/chroma-tenant", () => ({ ChromaTenantService: { createOrgDatabase: createDb } }));

const { POST } = await import("@/app/api/internal/ingestion/results/route");
const ids = { docId: "doc-1", orgId: "org-1", kbId: "kb-1" };
const send = (body: unknown, secret = "s3cret") =>
  POST(new Request("https://dash.test/api/internal/ingestion/results", {
    method: "POST", headers: { "content-type": "application/json", "x-internal-secret": secret }, body: JSON.stringify(body),
  }));
const chunk = (index: number) => ({ index, text: `chunk ${index}`, startIndex: index * 10, endIndex: index * 10 + 7, tokenCount: 2, embedding: [0.1, 0.2, 0.3] });

beforeEach(() => {
  process.env.INTERNAL_API_SECRET = "s3cret";
  docs = [{ id: "doc-1", kbId: "kb-1", orgId: "org-1", slug: "call.m4a", title: "call", status: "queued" }];
  objects = new Map([[`${prefix}/ingest/files/doc-1/chunks/part-0009.jsonl`, "stale"]]);
  deletedPrefixes = [];
  for (const fn of [upsert, prune, createDb]) fn.mockClear();
});

test("rejects a request without the internal secret", async () => {
  expect((await send({ type: "start", ...ids }, "wrong")).status).toBe(401);
  expect(docs[0].status).toBe("queued");
});

test("start -> chunks -> complete stores files in S3 and the worker's vectors in Chroma", async () => {
  expect((await send({ type: "start", ...ids })).status).toBe(200);
  expect(createDb).toHaveBeenCalledWith("org-1");
  expect(deletedPrefixes).toEqual([`${prefix}/ingest/files/doc-1/chunks/`]);
  expect(docs[0].status).toBe("digesting");

  expect((await send({ type: "chunks", ...ids, batch: 0, chunkingVersion: "v1", chunks: [chunk(0), chunk(1)] })).status).toBe(200);
  expect(upsert).toHaveBeenCalledWith("org-1",
    { kbId: "kb-1", docId: "doc-1", source: "call.m4a", title: "call", chunkingVersion: "v1" }, [chunk(0), chunk(1)]);
  const part = objects.get(`${prefix}/ingest/files/doc-1/chunks/part-0000.jsonl`)!;
  expect(part.trim().split("\n").map((l) => JSON.parse(l).embedding)).toEqual([[0.1, 0.2, 0.3], [0.1, 0.2, 0.3]]);

  expect((await send({ type: "complete", ...ids, markdown: "---\ndocId: doc-1\n---\n\nspeaker_1: hi [PERSON_1]\n", chunkCount: 2, chunkingVersion: "v1" })).status).toBe(200);
  expect(objects.get(`${prefix}/ingest/files/doc-1/content.md`)).toContain("[PERSON_1]");
  expect(prune).toHaveBeenCalledWith("org-1", "doc-1", 2);
  expect(docs[0]).toMatchObject({ status: "indexed", error: null, s3MarkdownKey: `${prefix}/ingest/files/doc-1/content.md` });
  expect(docs[0].indexedAt).toBeInstanceOf(Date);
});

test("a deleted document, or one claimed under another org, is a 404 so the worker drops the message", async () => {
  expect((await send({ type: "start", ...ids, orgId: "org-2" })).status).toBe(404);
  docs = [];
  expect((await send({ type: "start", ...ids })).status).toBe(404);
  expect(createDb).not.toHaveBeenCalled();
});

test("a retryable failure records the error; only the final one marks the document failed", async () => {
  await send({ type: "failed", ...ids, error: "RuntimeError: provider down", final: false });
  expect(docs[0]).toMatchObject({ status: "queued", error: "RuntimeError: provider down" });
  await send({ type: "failed", ...ids, error: "RuntimeError: provider down", final: true });
  expect(docs[0].status).toBe("failed");
});

test("malformed results are rejected before touching storage", async () => {
  expect((await send({ type: "chunks", ...ids, batch: 0, chunkingVersion: "v1", chunks: [] })).status).toBe(400);
  expect((await send({ type: "nope", ...ids })).status).toBe(400);
  expect(upsert).not.toHaveBeenCalled();
});

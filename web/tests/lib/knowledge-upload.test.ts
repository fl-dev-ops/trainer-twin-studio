import { errorResponse, refusals } from "@/lib/errors";
import { beforeEach, expect, mock, test } from "bun:test";

type DocData = { kbId: string; slug: string; title: string; ext: string; size: number; s3SourceKey: string; status: string };
type Doc = DocData & { id: string; createdAt: Date; s3MarkdownKey?: string; error?: string; sourceId?: string | null; indexedAt?: Date | null };
let rows: Doc[] = [];
let updates: Partial<Doc>[] = [];
let objects = new Map<string, { body: Uint8Array | string; contentType: string }>();
let failPath = "";
let studio = true;
let queueResult: boolean | Error = true;
const queue = mock(async (_file: { docId: string; orgId: string; kbId: string; filename: string; sourceKey: string }) => {
  if (queueResult instanceof Error) throw queueResult;
  return queueResult;
});
const removeVectors = mock(async () => {});
const prefix = "test/org-1";

mock.module("@/lib/ingestion-queue", () => ({ queueKnowledgeFile: queue }));
mock.module("@/lib/main-collection", () => ({ MainCollectionService: { removeKnowledgeDoc: removeVectors } }));
mock.module("@/lib/org", () => ({ getTrainerOrg: async () => studio ? { id: "org-1" } : null, studioOrRefusal: async () => (studio ? { id: "org-1" } : null) ?? errorResponse(refusals.signedOut()) }));
mock.module("@/lib/db", () => ({
  db: {
    knowledgeBase: { findFirst: async () => ({ id: "kb-1", slug: "acme-knowledge" }) },
    knowledgeDocument: {
      findMany: async () => rows.map((row) => ({ ...row, kb: { slug: "acme-knowledge" }, source: null })),
      findFirst: async ({ where }: { where: { id?: string; kbId?: string; slug?: string } }) =>
        rows.find((row) => where.id ? row.id === where.id : row.kbId === where.kbId && row.slug === where.slug) ?? null,
      create: async ({ data }: { data: DocData }) => {
        const row = { id: `doc-${rows.length + 1}`, createdAt: new Date(), ...data };
        rows.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Doc> }) => {
        updates.push(data);
        return Object.assign(rows.find((row) => row.id === where.id)!, data);
      },
      delete: async ({ where }: { where: { id: string } }) => { rows = rows.filter((row) => row.id !== where.id); },
    },
  },
}));
mock.module("@/lib/s3", () => ({
  orgPrefix: () => prefix,
  kbPrefix: (_org: string, kb: string, doc: string) => `${prefix}/knowledge/${kb}/${doc}`,
  putObject: async (key: string, body: Uint8Array | string, contentType: string) => {
    if (failPath && key.includes(failPath)) throw new Error("S3 unavailable");
    objects.set(key, { body, contentType });
  },
  presignedGetUrl: async (key: string) => `https://storage.test/${key}`,
  deletePrefix: async (path: string) => { for (const key of objects.keys()) if (key.startsWith(path)) objects.delete(key); },
}));

const { OrganizationKnowledgeService: service } = await import("@/lib/org-knowledge");
const { POST } = await import("@/app/api/knowledge/upload/route");

beforeEach(() => {
  rows = [];
  updates = [];
  objects = new Map();
  failPath = "";
  studio = true;
  queueResult = true;
  for (const fn of [queue, removeVectors]) fn.mockClear();
});

test("stores the original once and queues it for the ingestion worker", async () => {
  const bytes = new Uint8Array([37, 80, 68, 70, 0, 255]);
  const file = new File([bytes], "Client brief.pdf", { type: "application/pdf" });
  const doc = await service.uploadDocument("org-1", file);
  const rawKey = `${prefix}/knowledge/files/${doc.id}/Client-brief.pdf`;
  expect([...objects.keys()]).toEqual([rawKey]); // no unredacted Markdown copy: the worker writes the redacted one
  expect(objects.get(rawKey)).toEqual({ body: bytes, contentType: "application/pdf" });
  expect(queue).toHaveBeenCalledWith({ docId: doc.id, orgId: "org-1", kbId: "kb-1", filename: "Client-brief.pdf", sourceKey: rawKey });
  expect(rows[0]).toMatchObject({ status: "queued", s3SourceKey: rawKey, error: null });
  expect(doc).toMatchObject({ status: "queued", error: null, indexedAt: null });
  expect(await service.getPreviewUrl("org-1", doc.id)).toBe(`https://storage.test/${rawKey}`);
});

test("the API reports the upload as queued", async () => {
  const form = new FormData();
  form.set("file", new File(["  # Notes\n"], "notes.md", { type: "text/markdown" }));
  const res = await POST(new Request("https://dash.test/api/knowledge/upload", { method: "POST", body: form }));
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({ ok: true, status: "queued", document: { status: "queued" } });
  expect(objects.get(`${prefix}/knowledge/files/doc-1/notes.md`)?.body).toEqual(new TextEncoder().encode("  # Notes\n"));
});

test("audio and images are accepted: the worker transcribes and OCRs them", async () => {
  await service.uploadDocument("org-1", new File(["audio"], "Lesson 3.m4a", { type: "audio/mp4" }));
  await service.uploadDocument("org-1", new File(["image"], "slide.png", { type: "image/png" }));
  expect(rows.map((row) => row.status)).toEqual(["queued", "queued"]);
});

test("a failed S3 write marks the document failed and queues nothing", async () => {
  failPath = "/knowledge/files/";
  await expect(service.uploadDocument("org-1", new File(["Notes"], "notes.txt"))).rejects.toThrow("S3 unavailable");
  expect(rows[0]).toMatchObject({ status: "failed", error: "S3 unavailable" });
  expect(queue).not.toHaveBeenCalled();
});

test("without a queue the upload stays uploaded; a queue error is shown but the file is kept", async () => {
  queueResult = false;
  const local = await service.uploadDocument("org-1", new File(["one"], "a.txt"));
  expect(local).toMatchObject({ status: "uploaded", error: null });
  queueResult = new Error("SQS down");
  const failed = await service.uploadDocument("org-1", new File(["two"], "b.txt"));
  expect(failed.status).toBe("uploaded");
  expect(failed.error).toContain("could not be queued");
  expect(objects.size).toBe(2);
});

test("validation rejects unsupported, empty and oversized files before creating a document", async () => {
  await expect(service.uploadDocument("org-1", new File(["no"], "file.exe"))).rejects.toThrow("Unsupported file type");
  await expect(service.uploadDocument("org-1", new File([], "empty.txt"))).rejects.toThrow("File is empty");
  const oversized = new File(["big"], "large.txt");
  Object.defineProperty(oversized, "size", { value: 25 * 1024 * 1024 + 1 });
  await expect(service.uploadDocument("org-1", oversized)).rejects.toThrow("File larger than 25 MB");
  expect(rows).toHaveLength(0);
  expect(objects.size).toBe(0);
  expect(queue).not.toHaveBeenCalled();
});

test("same-named uploads stay separate; deleting one removes only its files", async () => {
  const first = await service.uploadDocument("org-1", new File(["one"], "notes.txt"));
  const second = await service.uploadDocument("org-1", new File(["two"], "notes.txt"));
  expect(first.slug).toBe("notes.txt");
  expect(second.slug).toBe("notes-1.txt");
  await service.deleteDocument("org-1", first.id);
  expect(objects.size).toBe(1);
  expect([...objects.keys()].every((key) => key.includes(`/${second.id}/`))).toBe(true);
  expect(rows).toHaveLength(1);
  expect(removeVectors).not.toHaveBeenCalled();
});

test("uploaded JSON still appears as an uploaded file after reloading the list", async () => {
  await service.uploadDocument("org-1", new File(['{"topic":"pricing"}'], "notes.json"));
  const docs = await service.getAllDocuments("org-1");
  expect(docs[0]).toMatchObject({ connector: "upload", status: "queued", ext: "json" });
});

test("upload endpoint still requires a studio member", async () => {
  studio = false;
  const res = await POST(new Request("https://dash.test/api/knowledge/upload", { method: "POST" }));
  expect(res.status).toBe(401);
  expect(objects.size).toBe(0);
});

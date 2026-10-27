import { beforeEach, expect, mock, test } from "bun:test";

type DocData = { kbId: string; slug: string; title: string; ext: string; size: number; s3SourceKey: string; status: string };
type Doc = DocData & { id: string; createdAt: Date; s3MarkdownKey?: string; error?: string; sourceId?: string | null; indexedAt?: Date | null };
let rows: Doc[] = [];
let updates: Partial<Doc>[] = [];
let objects = new Map<string, { body: Uint8Array | string; contentType: string }>();
let failPath = "";
let studio = true;
const convert = mock(async () => "# Converted PDF\n");
const createChroma = mock(async () => { throw new Error("Must not create Chroma storage"); });
const enqueue = mock(async () => { throw new Error("Must not enqueue ingestion"); });
const removeVectors = mock(async () => {});
const prefix = "test/org-1";

mock.module("@firecrawl/anydoc", () => ({ formatFromExtension: (ext: string) => ext, toMarkdownBytes: convert }));
mock.module("@/lib/chroma-tenant", () => ({ ChromaTenantService: { createOrgDatabase: createChroma } }));
mock.module("@/lib/ingestion-queue", () => ({ enqueueIngestionWork: enqueue }));
mock.module("@/lib/main-collection", () => ({ MainCollectionService: { removeKnowledgeDoc: removeVectors } }));
mock.module("@/lib/org", () => ({ getTrainerOrg: async () => studio ? { id: "org-1" } : null }));
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
  for (const fn of [convert, createChroma, enqueue, removeVectors]) fn.mockClear();
});

test("stores original bytes and converted Markdown in separate org folders, with no ingestion job", async () => {
  const bytes = new Uint8Array([37, 80, 68, 70, 0, 255]);
  const file = new File([bytes], "Client brief.pdf", { type: "application/pdf" });
  const doc = await service.uploadDocument("org-1", file);
  const rawKey = `${prefix}/knowledge/files/${doc.id}/Client-brief.pdf`;
  const mdKey = `${prefix}/ingest/files/${doc.id}/content.md`;
  expect(objects.size).toBe(2);
  expect(objects.get(rawKey)).toEqual({ body: bytes, contentType: "application/pdf" });
  expect(objects.get(mdKey)).toEqual({ body: "# Converted PDF", contentType: "text/markdown; charset=utf-8" });
  expect(convert).toHaveBeenCalledTimes(1);
  expect(rows[0]).toMatchObject({ status: "uploaded", s3SourceKey: rawKey, s3MarkdownKey: mdKey });
  expect(doc).toMatchObject({ status: "uploaded", jobId: null, sourceId: null, indexedAt: null });
  expect(createChroma).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
  expect(await service.getPreviewUrl("org-1", doc.id)).toBe(`https://storage.test/${rawKey}`);
});

test("the API reports a finished upload, not queued processing", async () => {
  const form = new FormData();
  form.set("file", new File(["  # Notes\n"], "notes.md", { type: "text/markdown" }));
  const res = await POST(new Request("https://dash.test/api/knowledge/upload", { method: "POST", body: form }));
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({ ok: true, status: "uploaded", jobId: null, document: { status: "uploaded" } });
  expect(objects.get(`${prefix}/knowledge/files/doc-1/notes.md`)?.body).toEqual(new TextEncoder().encode("  # Notes\n"));
  expect(objects.get(`${prefix}/ingest/files/doc-1/content.md`)?.body).toBe("# Notes");
});

for (const path of ["/knowledge/files/", "/ingest/files/"]) {
  test(`a failed write to ${path} never marks the document complete`, async () => {
    failPath = path;
    await expect(service.uploadDocument("org-1", new File(["Notes"], "notes.txt"))).rejects.toThrow("S3 unavailable");
    expect(rows[0]).toMatchObject({ status: "failed", error: "S3 unavailable" });
    expect(updates.some((data) => data.status === "uploaded")).toBe(false);
    expect(rows[0].s3SourceKey).toContain("/knowledge/files/");
    expect(rows[0].s3MarkdownKey).toContain("/ingest/files/");
    expect(enqueue).not.toHaveBeenCalled();
  });
}

test("validation rejects unsupported, empty and oversized files before creating a document", async () => {
  await expect(service.uploadDocument("org-1", new File(["no"], "file.exe"))).rejects.toThrow("Unsupported file type");
  await expect(service.uploadDocument("org-1", new File(["   "], "empty.txt"))).rejects.toThrow("No readable text");
  const oversized = new File(["big"], "large.txt");
  Object.defineProperty(oversized, "size", { value: 25 * 1024 * 1024 + 1 });
  await expect(service.uploadDocument("org-1", oversized)).rejects.toThrow("File larger than 25 MB");
  expect(rows).toHaveLength(0);
  expect(objects.size).toBe(0);
});

test("same-named uploads stay separate; deleting one removes only its two copies", async () => {
  const first = await service.uploadDocument("org-1", new File(["one"], "notes.txt"));
  const second = await service.uploadDocument("org-1", new File(["two"], "notes.txt"));
  expect(first.slug).toBe("notes.txt");
  expect(second.slug).toBe("notes-1.txt");
  await service.deleteDocument("org-1", first.id);
  expect(objects.size).toBe(2);
  expect([...objects.keys()].every((key) => key.includes(`/${second.id}/`))).toBe(true);
  expect(rows).toHaveLength(1);
  expect(removeVectors).not.toHaveBeenCalled();
});

test("uploaded JSON still appears as an uploaded file after reloading the list", async () => {
  await service.uploadDocument("org-1", new File(['{"topic":"pricing"}'], "notes.json"));
  const docs = await service.getAllDocuments("org-1");
  expect(docs[0]).toMatchObject({ connector: "upload", status: "uploaded", ext: "json" });
});

test("upload endpoint still requires a studio member", async () => {
  studio = false;
  const res = await POST(new Request("https://dash.test/api/knowledge/upload", { method: "POST" }));
  expect(res.status).toBe(401);
  expect(objects.size).toBe(0);
});

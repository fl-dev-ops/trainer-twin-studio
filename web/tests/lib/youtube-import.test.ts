import { beforeEach, expect, mock, test } from "bun:test";

type Row = Record<string, unknown> & { id: string };
let sources: Row[] = [];
let docs: Row[] = [];
let queued: unknown[] = [];
let queueOk = true;
let privacy = "unlisted";

mock.module("@/lib/db", () => ({
  db: {
    knowledgeBase: { findFirst: async () => ({ id: "kb-1", slug: "kb" }) },
    youTubeConnection: { findFirst: async () => ({ id: "conn-1", userId: "user-1", channelTitle: "Olga" }) },
    knowledgeSource: {
      upsert: async ({ where, create }: { where: { identityKey: string }; create: Row }) => {
        const found = sources.find((s) => s.identityKey === where.identityKey);
        if (found) return Object.assign(found, { status: "syncing" });
        const row = { ...create, id: `src-${sources.length + 1}` };
        sources.push(row);
        return row;
      },
    },
    knowledgeDocument: {
      findFirst: async () => null,
      upsert: async ({ create, update }: { create: Row; update: Row }) => {
        const found = docs.find((d) => d.externalId === create.externalId);
        if (found) return Object.assign(found, update);
        const row = { ...create, id: `doc-${docs.length + 1}` };
        docs.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(docs.find((d) => d.id === where.id)!, data),
    },
  },
}));
mock.module("@/lib/youtube-server", () => ({
  youtubeClient: () => ({
    verifyOwnedVideo: async (_scope: unknown, videoId: string) => {
      if (privacy === "private") throw new Error("Private videos can't be imported");
      return { videoId, title: "Is this 2008 in Dubai?", channelId: "ch", channelTitle: "Olga", privacyStatus: privacy };
    },
  }),
}));
mock.module("@/lib/ingestion-queue", () => ({
  defaultIdentityKey: (kb: string, c: string, e: string) => `${kb}:${c}:${e}`,
  queueVideoFetch: async (video: unknown) => { queued.push(video); return queueOk; },
}));
mock.module("@/lib/s3", () => ({ orgPrefix: () => "test/org-1" }));
mock.module("@/lib/org-knowledge", () => ({ getOrCreateOrgKnowledgeBase: async () => ({ id: "kb-1", slug: "kb" }) }));

const { queueYouTubeSync } = await import("@/lib/youtube-ingestion");
const input = { orgId: "org-1", userId: "user-1", kbId: "kb-1", url: "https://youtu.be/7H9AfVyuliU", connectionId: "conn-1" };

beforeEach(() => { sources = []; docs = []; queued = []; queueOk = true; privacy = "unlisted"; });

test("an owned video becomes a document and a fetch message for the worker", async () => {
  const result = await queueYouTubeSync(input);
  expect(result).toMatchObject({ ok: true, status: "queued", documentId: "doc-1", sourceId: "src-1" });
  expect(sources[0]).toMatchObject({ connector: "youtube", externalId: "7H9AfVyuliU", sourceUrl: "https://www.youtube.com/watch?v=7H9AfVyuliU" });
  expect(docs[0]).toMatchObject({ ext: "mp4", status: "fetching", title: "Is this 2008 in Dubai?",
    s3SourceKey: "test/org-1/knowledge/files/doc-1/youtube-7H9AfVyuliU.mp4" });
  expect(queued).toEqual([{ docId: "doc-1", orgId: "org-1", kbId: "kb-1", url: "https://www.youtube.com/watch?v=7H9AfVyuliU",
    sourceKey: "test/org-1/knowledge/files/doc-1/youtube-7H9AfVyuliU.mp4" }]);
});

test("re-importing reuses the same source and document", async () => {
  await queueYouTubeSync(input);
  await queueYouTubeSync({ ...input, refresh: true });
  expect(sources).toHaveLength(1);
  expect(docs).toHaveLength(1);
  expect(queued).toHaveLength(2);
});

test("private videos are refused before anything is stored", async () => {
  privacy = "private";
  await expect(queueYouTubeSync(input)).rejects.toThrow("Private videos");
  expect(docs).toHaveLength(0);
  expect(queued).toHaveLength(0);
});

test("without a queue the document is marked failed instead of hanging in fetching", async () => {
  queueOk = false;
  const result = await queueYouTubeSync(input);
  expect(result.status).toBe("failed");
  expect(docs[0]).toMatchObject({ status: "failed", error: "Ingestion queue is not configured" });
});

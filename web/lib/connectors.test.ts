import assert from "node:assert/strict";
import test from "node:test";
import { parseNotionPageId, notionImportSchema } from "./notion";
import { parseYouTubeVideoId, youtubeImportSchema } from "./youtube";
import { ingestionMessageSchema } from "./ingestion-message";

test("Notion page ID parsing handles standard URLs, short URLs, and raw UUIDs", () => {
  const standardUrl =
    "https://www.notion.so/myworkspace/Engineering-Guidelines-1234567890abcdef1234567890abcdef";
  assert.equal(
    parseNotionPageId(standardUrl),
    "12345678-90ab-cdef-1234-567890abcdef",
  );

  const rawUuid = "12345678-90ab-cdef-1234-567890abcdef";
  assert.equal(
    parseNotionPageId(rawUuid),
    "12345678-90ab-cdef-1234-567890abcdef",
  );

  const rawCompact = "1234567890abcdef1234567890abcdef";
  assert.equal(
    parseNotionPageId(rawCompact),
    "12345678-90ab-cdef-1234-567890abcdef",
  );
});

test("Notion import schema differentiates owned vs public imports", () => {
  const ownedValid = notionImportSchema.safeParse({
    mode: "oauth",
    url: "https://www.notion.so/myworkspace/Page-1234567890abcdef1234567890abcdef",
    connectionId: "conn-123",
  });
  assert.equal(ownedValid.success, true);

  const publicValid = notionImportSchema.safeParse({
    mode: "public",
    url: "https://myworkspace.notion.site/Page-1234567890abcdef1234567890abcdef",
  });
  assert.equal(publicValid.success, true);

  const publicWithConn = notionImportSchema.safeParse({
    mode: "public",
    url: "https://myworkspace.notion.site/Page-1234567890abcdef1234567890abcdef",
    connectionId: "conn-123",
  });
  assert.equal(publicWithConn.success, false);
});

test("YouTube video ID parsing extracts video ID across multiple URL formats", () => {
  assert.equal(
    parseYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    "dQw4w9WgXcQ",
  );
  assert.equal(
    parseYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ"),
    "dQw4w9WgXcQ",
  );
  assert.equal(
    parseYouTubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ"),
    "dQw4w9WgXcQ",
  );
  assert.equal(
    parseYouTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"),
    "dQw4w9WgXcQ",
  );
  assert.equal(parseYouTubeVideoId("https://example.com/not-youtube"), null);
});

test("YouTube import schema validates connection and URL", () => {
  const valid = youtubeImportSchema.safeParse({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    connectionId: "conn-yt-123",
  });
  assert.equal(valid.success, true);

  const invalidUrl = youtubeImportSchema.safeParse({
    url: "https://vimeo.com/123456",
    connectionId: "conn-yt-123",
  });
  assert.equal(invalidUrl.success, false);
});

test("Ingestion message schema strictly enforces identifier-only payload", () => {
  const valid = ingestionMessageSchema.safeParse({
    jobId: "job-123",
    workItemId: "work-456",
  });
  assert.equal(valid.success, true);

  // Extra payload fields must be rejected to prevent sensitive data leaks
  const extraFields = ingestionMessageSchema.safeParse({
    jobId: "job-123",
    workItemId: "work-456",
    token: "secret-token",
  });
  assert.equal(extraFields.success, false);
});

test("Notion token encryption binds to connection scope via AAD", async () => {
  process.env.NOTION_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const { encryptNotionToken, decryptNotionToken, notionTokenBinding } = await import("./notion-token");

  const scope1 = { orgId: "org-1", userId: "user-1", connectionId: "conn-1" };
  const scope2 = { orgId: "org-2", userId: "user-2", connectionId: "conn-2" };

  const binding1 = notionTokenBinding(scope1);
  const binding2 = notionTokenBinding(scope2);

  const rawToken = "secret_notion_token_value_abc123";
  const encrypted = encryptNotionToken(rawToken, binding1);

  // Valid decryption with identical binding
  const decrypted = decryptNotionToken(encrypted, binding1);
  assert.equal(decrypted, rawToken);

  // Rejection when decrypted with different tenant binding
  assert.throws(() => {
    decryptNotionToken(encrypted, binding2);
  }, /cannot be decrypted/);
});

test("defaultIdentityKey produces consistent derivation across connectors", async () => {
  const { defaultIdentityKey } = await import("./ingestion-queue");
  assert.equal(defaultIdentityKey("kb-1", "youtube", "video-123"), "kb-1:youtube:video-123");
  assert.equal(defaultIdentityKey("kb-1", "notion", "page-456"), "kb-1:notion:page-456");
  assert.equal(defaultIdentityKey("kb-1", "notion_public", "page-456"), "kb-1:notion_public:page-456");
  assert.equal(defaultIdentityKey("kb-1", "upload", "doc-789"), "kb-1:upload:doc-789");
});

-- Preserve existing ingestion history while moving to connector-neutral work items.
ALTER TABLE "IngestionPage" RENAME TO "IngestionWorkItem";
DROP INDEX "IngestionPage_jobId_pageId_key";
DROP INDEX "IngestionPage_jobId_status_idx";
ALTER TABLE "IngestionWorkItem" DROP CONSTRAINT "IngestionPage_jobId_fkey";
ALTER TABLE "IngestionWorkItem" RENAME COLUMN "pageId" TO "workKey";
ALTER TABLE "IngestionWorkItem"
  ADD COLUMN "parentWorkItemId" TEXT,
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'resource',
  ADD COLUMN "payload" JSONB,
  ADD COLUMN "artifactKey" TEXT,
  ADD COLUMN "artifactHash" TEXT,
  ADD COLUMN "chunkCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);
UPDATE "IngestionWorkItem" AS child
SET "parentWorkItemId" = parent."id"
FROM "IngestionWorkItem" AS parent
WHERE child."jobId" = parent."jobId"
  AND child."parentPageId" = parent."workKey";
ALTER TABLE "IngestionWorkItem" DROP COLUMN "parentPageId";

CREATE TABLE "NotionSourceConfig" (
  "sourceId" TEXT NOT NULL,
  "connectionId" TEXT,
  "accessMode" TEXT NOT NULL,
  CONSTRAINT "NotionSourceConfig_pkey" PRIMARY KEY ("sourceId")
);
INSERT INTO "NotionSourceConfig" ("sourceId", "connectionId", "accessMode")
SELECT "id", "notionConnectionId",
  CASE WHEN "type" = 'notion_public' THEN 'public' ELSE 'owned' END
FROM "KnowledgeSource"
WHERE "type" IN ('notion', 'notion_public');
CREATE INDEX "NotionSourceConfig_connectionId_idx" ON "NotionSourceConfig"("connectionId");
ALTER TABLE "NotionSourceConfig" ADD CONSTRAINT "NotionSourceConfig_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotionSourceConfig" ADD CONSTRAINT "NotionSourceConfig_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "NotionConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "YouTubeSourceConfig" (
  "sourceId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "captionId" TEXT,
  "captionUpdatedAt" TIMESTAMP(3),
  "fetchedAt" TIMESTAMP(3),
  CONSTRAINT "YouTubeSourceConfig_pkey" PRIMARY KEY ("sourceId")
);
INSERT INTO "YouTubeSourceConfig" (
  "sourceId", "connectionId", "captionId", "captionUpdatedAt", "fetchedAt"
)
SELECT
  "id", "youtubeConnectionId", "youtubeCaptionId", "youtubeCaptionUpdatedAt", "youtubeFetchedAt"
FROM "KnowledgeSource"
WHERE "type" = 'youtube' AND "youtubeConnectionId" IS NOT NULL;
CREATE INDEX "YouTubeSourceConfig_connectionId_idx" ON "YouTubeSourceConfig"("connectionId");
CREATE INDEX "YouTubeSourceConfig_fetchedAt_idx" ON "YouTubeSourceConfig"("fetchedAt");
ALTER TABLE "YouTubeSourceConfig" ADD CONSTRAINT "YouTubeSourceConfig_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "YouTubeSourceConfig" ADD CONSTRAINT "YouTubeSourceConfig_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "YouTubeConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "KnowledgeSource" DROP CONSTRAINT "KnowledgeSource_notionConnectionId_fkey";
ALTER TABLE "KnowledgeSource" DROP CONSTRAINT "KnowledgeSource_youtubeConnectionId_fkey";
DROP INDEX "KnowledgeSource_kbId_type_externalId_notionConnectionId_key";
DROP INDEX "KnowledgeSource_notionConnectionId_idx";
DROP INDEX "KnowledgeSource_youtubeConnectionId_idx";
DROP INDEX "KnowledgeSource_publicKey_key";

ALTER TABLE "KnowledgeSource"
  DROP COLUMN "notionConnectionId",
  DROP COLUMN "youtubeConnectionId",
  DROP COLUMN "youtubeCaptionId",
  DROP COLUMN "youtubeCaptionUpdatedAt",
  DROP COLUMN "youtubeFetchedAt",
  DROP COLUMN "youtubeFetchedJobId";
ALTER TABLE "KnowledgeSource" RENAME COLUMN "type" TO "connector";
ALTER TABLE "KnowledgeSource" RENAME COLUMN "publicKey" TO "identityKey";
ALTER TABLE "KnowledgeSource" ALTER COLUMN "identityKey" SET NOT NULL;

CREATE UNIQUE INDEX "KnowledgeSource_identityKey_key" ON "KnowledgeSource"("identityKey");
CREATE INDEX "KnowledgeSource_connector_status_idx" ON "KnowledgeSource"("connector", "status");

ALTER TABLE "IngestionJob" RENAME COLUMN "pagesDiscovered" TO "itemsDiscovered";
ALTER TABLE "IngestionJob" RENAME COLUMN "pagesProcessed" TO "itemsProcessed";

CREATE UNIQUE INDEX "IngestionWorkItem_jobId_workKey_key" ON "IngestionWorkItem"("jobId", "workKey");
CREATE INDEX "IngestionWorkItem_jobId_status_idx" ON "IngestionWorkItem"("jobId", "status");
CREATE INDEX "IngestionWorkItem_status_leaseExpiresAt_idx" ON "IngestionWorkItem"("status", "leaseExpiresAt");
CREATE INDEX "IngestionWorkItem_parentWorkItemId_idx" ON "IngestionWorkItem"("parentWorkItemId");
ALTER TABLE "IngestionWorkItem" ADD CONSTRAINT "IngestionWorkItem_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "IngestionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IngestionWorkItem" ADD CONSTRAINT "IngestionWorkItem_parentWorkItemId_fkey"
  FOREIGN KEY ("parentWorkItemId") REFERENCES "IngestionWorkItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

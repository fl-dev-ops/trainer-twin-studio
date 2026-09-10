-- CreateEnum
CREATE TYPE "TopicStatus" AS ENUM ('proposed', 'approved');

-- AlterTable
ALTER TABLE "KnowledgeDocument"
  ADD COLUMN "sourceId" TEXT,
  ADD COLUMN "externalId" TEXT,
  ADD COLUMN "externalUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "parentExternalId" TEXT,
  ADD COLUMN "s3QuestionsKey" TEXT,
  ALTER COLUMN "s3MarkdownKey" DROP NOT NULL;

-- CreateTable
CREATE TABLE "KnowledgeSource" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kbId" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastSyncedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotionSourceConfig" (
    "sourceId" TEXT NOT NULL,
    "connectionId" TEXT,
    "accessMode" TEXT NOT NULL,

    CONSTRAINT "NotionSourceConfig_pkey" PRIMARY KEY ("sourceId")
);

-- CreateTable
CREATE TABLE "YouTubeSourceConfig" (
    "sourceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "captionId" TEXT,
    "captionUpdatedAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3),

    CONSTRAINT "YouTubeSourceConfig_pkey" PRIMARY KEY ("sourceId")
);

-- CreateTable
CREATE TABLE "IngestionJob" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "activeKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "stage" TEXT,
    "itemsDiscovered" INTEGER NOT NULL DEFAULT 0,
    "itemsProcessed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngestionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestionWorkItem" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "workKey" TEXT NOT NULL,
    "parentWorkItemId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'resource',
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "artifactKey" TEXT,
    "artifactHash" TEXT,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAt" TIMESTAMP(3),
    "enqueuedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngestionWorkItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YouTubeConnection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "channelTitle" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "accessTokenCiphertext" TEXT,
    "refreshTokenCiphertext" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "refreshLeaseId" TEXT,
    "refreshLeaseExpiresAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YouTubeConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YouTubeOAuthState" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kbId" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "YouTubeOAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotionConnection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "workspaceName" TEXT,
    "workspaceIcon" TEXT,
    "botId" TEXT,
    "accessTokenCiphertext" TEXT NOT NULL,
    "refreshTokenCiphertext" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotionConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotionOAuthState" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kbId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotionOAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Topic" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "TopicStatus" NOT NULL DEFAULT 'approved',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Topic_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeSource_identityKey_key" ON "KnowledgeSource"("identityKey");
CREATE INDEX "KnowledgeSource_orgId_idx" ON "KnowledgeSource"("orgId");
CREATE INDEX "KnowledgeSource_kbId_idx" ON "KnowledgeSource"("kbId");
CREATE INDEX "KnowledgeSource_connector_status_idx" ON "KnowledgeSource"("connector", "status");

-- CreateIndex
CREATE INDEX "NotionSourceConfig_connectionId_idx" ON "NotionSourceConfig"("connectionId");

-- CreateIndex
CREATE INDEX "YouTubeSourceConfig_connectionId_idx" ON "YouTubeSourceConfig"("connectionId");
CREATE INDEX "YouTubeSourceConfig_fetchedAt_idx" ON "YouTubeSourceConfig"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeDocument_sourceId_externalId_key" ON "KnowledgeDocument"("sourceId", "externalId");
CREATE INDEX "KnowledgeDocument_sourceId_idx" ON "KnowledgeDocument"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "idx_ingestion_job_active_source" ON "IngestionJob"("sourceId") WHERE status IN ('queued', 'running');
CREATE INDEX "IngestionJob_status_createdAt_idx" ON "IngestionJob"("status", "createdAt");
CREATE INDEX "IngestionJob_sourceId_status_idx" ON "IngestionJob"("sourceId", "status");
CREATE INDEX "IngestionJob_activeKey_idx" ON "IngestionJob"("activeKey");

-- CreateIndex
CREATE UNIQUE INDEX "IngestionWorkItem_jobId_workKey_key" ON "IngestionWorkItem"("jobId", "workKey");
CREATE INDEX "IngestionWorkItem_jobId_status_idx" ON "IngestionWorkItem"("jobId", "status");
CREATE INDEX "IngestionWorkItem_status_leaseExpiresAt_idx" ON "IngestionWorkItem"("status", "leaseExpiresAt");
CREATE INDEX "IngestionWorkItem_parentWorkItemId_idx" ON "IngestionWorkItem"("parentWorkItemId");

-- CreateIndex
CREATE UNIQUE INDEX "YouTubeConnection_orgId_channelId_key" ON "YouTubeConnection"("orgId", "channelId");
CREATE INDEX "YouTubeConnection_orgId_userId_idx" ON "YouTubeConnection"("orgId", "userId");
CREATE INDEX "YouTubeConnection_status_lastVerifiedAt_idx" ON "YouTubeConnection"("status", "lastVerifiedAt");

-- CreateIndex
CREATE INDEX "YouTubeOAuthState_expiresAt_idx" ON "YouTubeOAuthState"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotionConnection_orgId_workspaceId_key" ON "NotionConnection"("orgId", "workspaceId");
CREATE INDEX "NotionConnection_orgId_userId_idx" ON "NotionConnection"("orgId", "userId");

-- CreateIndex
CREATE INDEX "NotionOAuthState_orgId_userId_idx" ON "NotionOAuthState"("orgId", "userId");
CREATE INDEX "NotionOAuthState_expiresAt_idx" ON "NotionOAuthState"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Topic_slug_key" ON "Topic"("slug");

-- AddForeignKey
ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeSource" ADD CONSTRAINT "KnowledgeSource_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeSource" ADD CONSTRAINT "KnowledgeSource_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotionSourceConfig" ADD CONSTRAINT "NotionSourceConfig_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotionSourceConfig" ADD CONSTRAINT "NotionSourceConfig_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "NotionConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YouTubeSourceConfig" ADD CONSTRAINT "YouTubeSourceConfig_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YouTubeSourceConfig" ADD CONSTRAINT "YouTubeSourceConfig_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "YouTubeConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngestionJob" ADD CONSTRAINT "IngestionJob_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngestionWorkItem" ADD CONSTRAINT "IngestionWorkItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "IngestionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngestionWorkItem" ADD CONSTRAINT "IngestionWorkItem_parentWorkItemId_fkey" FOREIGN KEY ("parentWorkItemId") REFERENCES "IngestionWorkItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YouTubeConnection" ADD CONSTRAINT "YouTubeConnection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YouTubeConnection" ADD CONSTRAINT "YouTubeConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YouTubeOAuthState" ADD CONSTRAINT "YouTubeOAuthState_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YouTubeOAuthState" ADD CONSTRAINT "YouTubeOAuthState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YouTubeOAuthState" ADD CONSTRAINT "YouTubeOAuthState_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotionConnection" ADD CONSTRAINT "NotionConnection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotionConnection" ADD CONSTRAINT "NotionConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotionOAuthState" ADD CONSTRAINT "NotionOAuthState_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotionOAuthState" ADD CONSTRAINT "NotionOAuthState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotionOAuthState" ADD CONSTRAINT "NotionOAuthState_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

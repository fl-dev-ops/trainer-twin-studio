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
CREATE TABLE "KnowledgeSource" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kbId" TEXT NOT NULL,
    "notionConnectionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastSyncedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestionJob" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "pagesDiscovered" INTEGER NOT NULL DEFAULT 0,
    "pagesProcessed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngestionJob_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "KnowledgeDocument"
ADD COLUMN "sourceId" TEXT,
ADD COLUMN "externalId" TEXT,
ADD COLUMN "externalUpdatedAt" TIMESTAMP(3),
ADD COLUMN "parentExternalId" TEXT;

-- AlterTable
ALTER TABLE "IngestionJob" ADD COLUMN "activeKey" TEXT;

-- CreateTable
CREATE TABLE "IngestionPage" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "parentPageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "enqueuedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngestionPage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotionConnection_orgId_userId_workspaceId_key" ON "NotionConnection"("orgId", "userId", "workspaceId");
CREATE INDEX "NotionConnection_orgId_userId_idx" ON "NotionConnection"("orgId", "userId");
CREATE INDEX "NotionOAuthState_orgId_userId_idx" ON "NotionOAuthState"("orgId", "userId");
CREATE INDEX "NotionOAuthState_expiresAt_idx" ON "NotionOAuthState"("expiresAt");
CREATE UNIQUE INDEX "KnowledgeSource_kbId_type_externalId_notionConnectionId_key" ON "KnowledgeSource"("kbId", "type", "externalId", "notionConnectionId");
CREATE INDEX "KnowledgeSource_orgId_idx" ON "KnowledgeSource"("orgId");
CREATE INDEX "KnowledgeSource_kbId_idx" ON "KnowledgeSource"("kbId");
CREATE INDEX "KnowledgeSource_notionConnectionId_idx" ON "KnowledgeSource"("notionConnectionId");
CREATE UNIQUE INDEX "KnowledgeDocument_sourceId_externalId_key" ON "KnowledgeDocument"("sourceId", "externalId");
CREATE INDEX "KnowledgeDocument_sourceId_idx" ON "KnowledgeDocument"("sourceId");
CREATE INDEX "IngestionJob_status_createdAt_idx" ON "IngestionJob"("status", "createdAt");
CREATE INDEX "IngestionJob_sourceId_idx" ON "IngestionJob"("sourceId");
CREATE UNIQUE INDEX "IngestionJob_activeKey_key" ON "IngestionJob"("activeKey");
CREATE UNIQUE INDEX "IngestionPage_jobId_pageId_key" ON "IngestionPage"("jobId", "pageId");
CREATE INDEX "IngestionPage_jobId_status_idx" ON "IngestionPage"("jobId", "status");

-- AddForeignKey
ALTER TABLE "NotionConnection" ADD CONSTRAINT "NotionConnection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotionConnection" ADD CONSTRAINT "NotionConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotionOAuthState" ADD CONSTRAINT "NotionOAuthState_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotionOAuthState" ADD CONSTRAINT "NotionOAuthState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotionOAuthState" ADD CONSTRAINT "NotionOAuthState_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeSource" ADD CONSTRAINT "KnowledgeSource_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeSource" ADD CONSTRAINT "KnowledgeSource_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeSource" ADD CONSTRAINT "KnowledgeSource_notionConnectionId_fkey" FOREIGN KEY ("notionConnectionId") REFERENCES "NotionConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IngestionJob" ADD CONSTRAINT "IngestionJob_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IngestionPage" ADD CONSTRAINT "IngestionPage_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "IngestionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

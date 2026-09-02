CREATE TABLE "YouTubeConnection" (
  "id" TEXT PRIMARY KEY, "orgId" TEXT NOT NULL, "userId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL, "channelTitle" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'active',
  "accessTokenCiphertext" TEXT, "refreshTokenCiphertext" TEXT, "tokenExpiresAt" TIMESTAMP(3),
  "refreshLeaseId" TEXT, "refreshLeaseExpiresAt" TIMESTAMP(3),
  "lastVerifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "YouTubeConnection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "YouTubeConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "YouTubeConnection_orgId_userId_channelId_key" ON "YouTubeConnection"("orgId", "userId", "channelId");
CREATE INDEX "YouTubeConnection_orgId_userId_idx" ON "YouTubeConnection"("orgId", "userId");
CREATE INDEX "YouTubeConnection_status_lastVerifiedAt_idx" ON "YouTubeConnection"("status", "lastVerifiedAt");

CREATE TABLE "YouTubeOAuthState" (
  "id" TEXT PRIMARY KEY, "orgId" TEXT NOT NULL, "userId" TEXT NOT NULL, "kbId" TEXT NOT NULL,
  "codeVerifier" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3),
  CONSTRAINT "YouTubeOAuthState_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "YouTubeOAuthState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "YouTubeOAuthState_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "YouTubeOAuthState_expiresAt_idx" ON "YouTubeOAuthState"("expiresAt");

ALTER TABLE "KnowledgeSource" ADD COLUMN "youtubeConnectionId" TEXT,
  ADD COLUMN "youtubeCaptionId" TEXT, ADD COLUMN "youtubeCaptionUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "youtubeFetchedAt" TIMESTAMP(3), ADD COLUMN "youtubeFetchedJobId" TEXT;
ALTER TABLE "KnowledgeSource" ADD CONSTRAINT "KnowledgeSource_youtubeConnectionId_fkey"
  FOREIGN KEY ("youtubeConnectionId") REFERENCES "YouTubeConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "KnowledgeSource_youtubeConnectionId_idx" ON "KnowledgeSource"("youtubeConnectionId");
ALTER TABLE "IngestionJob" ADD COLUMN "stage" TEXT;

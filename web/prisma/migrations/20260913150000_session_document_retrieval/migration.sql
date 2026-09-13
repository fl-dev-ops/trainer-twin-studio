-- AlterTable
ALTER TABLE "ContextDocument"
  ADD COLUMN "ownerUserId" TEXT,
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'document',
  ADD COLUMN "sha256" TEXT,
  ADD COLUMN "extractedText" TEXT,
  ADD COLUMN "manifest" JSONB;

-- CreateTable
CREATE TABLE "ContextDocumentChunk" (
  "id" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "chunkIndex" INTEGER NOT NULL,
  "heading" TEXT,
  "pageNumber" INTEGER,
  "text" TEXT NOT NULL,
  CONSTRAINT "ContextDocumentChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterviewSessionDocument" (
  "sessionId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InterviewSessionDocument_pkey" PRIMARY KEY ("sessionId", "documentId")
);

-- Indexes
CREATE INDEX "ContextDocument_orgId_ownerUserId_idx" ON "ContextDocument"("orgId", "ownerUserId");
CREATE INDEX "ContextDocumentChunk_documentId_idx" ON "ContextDocumentChunk"("documentId");
CREATE INDEX "ContextDocumentChunk_text_fts_idx" ON "ContextDocumentChunk" USING GIN (to_tsvector('simple', "text"));
CREATE INDEX "InterviewSessionDocument_sessionId_idx" ON "InterviewSessionDocument"("sessionId");
CREATE INDEX "InterviewSessionDocument_documentId_idx" ON "InterviewSessionDocument"("documentId");

-- ForeignKeys
ALTER TABLE "ContextDocument" ADD CONSTRAINT "ContextDocument_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContextDocumentChunk" ADD CONSTRAINT "ContextDocumentChunk_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "ContextDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InterviewSessionDocument" ADD CONSTRAINT "InterviewSessionDocument_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "InterviewSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InterviewSessionDocument" ADD CONSTRAINT "InterviewSessionDocument_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "ContextDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill existing one-file session links.
INSERT INTO "InterviewSessionDocument" ("sessionId", "documentId")
SELECT "id", "contextId" FROM "InterviewSession" WHERE "contextId" IS NOT NULL
ON CONFLICT DO NOTHING;

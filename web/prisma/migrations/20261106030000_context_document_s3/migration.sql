-- User uploads (ContextDocument) move to S3: bytes optional, the S3 key, upload status, purpose and expiry.
ALTER TABLE "ContextDocument" ALTER COLUMN "content" DROP NOT NULL;
ALTER TABLE "ContextDocument" ADD COLUMN "s3Key" TEXT;
ALTER TABLE "ContextDocument" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE "ContextDocument" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'before';
ALTER TABLE "ContextDocument" ADD COLUMN "expiresAt" TIMESTAMP(3);
CREATE INDEX "ContextDocument_status_expiresAt_idx" ON "ContextDocument"("status", "expiresAt");

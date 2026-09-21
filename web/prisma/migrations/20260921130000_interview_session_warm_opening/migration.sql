-- Prewarmed opening artifacts for the chat brain (style hits + surface-queued flag).
ALTER TABLE "InterviewSession" ADD COLUMN "warmOpening" JSONB;

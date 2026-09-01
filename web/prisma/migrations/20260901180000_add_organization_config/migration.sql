-- Generic organization configuration used by delegated host mounts.
ALTER TABLE "organization" ADD COLUMN "config" JSONB;

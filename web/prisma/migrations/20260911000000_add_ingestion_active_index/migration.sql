-- Drop old unique index on activeKey
DROP INDEX IF EXISTS "IngestionJob_activeKey_key";

-- Drop old simple sourceId index if replacing with composite
DROP INDEX IF EXISTS "IngestionJob_sourceId_idx";

-- Create partial unique index on active sources to guarantee single concurrent active job
CREATE UNIQUE INDEX "idx_ingestion_job_active_source" ON "IngestionJob"("sourceId") WHERE status IN ('queued', 'running');

-- Create composite index on sourceId and status
CREATE INDEX IF NOT EXISTS "IngestionJob_sourceId_status_idx" ON "IngestionJob"("sourceId", "status");

-- Create index on activeKey
CREATE INDEX IF NOT EXISTS "IngestionJob_activeKey_idx" ON "IngestionJob"("activeKey");

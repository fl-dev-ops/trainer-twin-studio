ALTER TABLE "InterviewSession"
  ADD COLUMN "compiledSnapshot" JSONB,
  ADD COLUMN "lastCompletion" JSONB,
  ADD COLUMN "runtimeRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "runtimeState" JSONB;

CREATE UNIQUE INDEX "InterviewSession_runtimeTokenHash_key"
  ON "InterviewSession"("runtimeTokenHash");

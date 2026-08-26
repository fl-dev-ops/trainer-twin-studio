-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "orgId" TEXT,
ADD COLUMN     "visibility" TEXT NOT NULL DEFAULT 'public';

-- AlterTable
ALTER TABLE "ContextDocument" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "Domain" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "InterviewSession" ADD COLUMN     "evidence" JSONB,
ADD COLUMN     "learnerId" TEXT,
ADD COLUMN     "orgId" TEXT,
ADD COLUMN     "s3AudioKey" TEXT,
ADD COLUMN     "transcript" JSONB;

-- AlterTable
ALTER TABLE "KnowledgeBase" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "Persona" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "SpecDraft" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "SpecVersion" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "Voice" ADD COLUMN     "orgId" TEXT;

-- CreateIndex
CREATE INDEX "Agent_orgId_idx" ON "Agent"("orgId");

-- CreateIndex
CREATE INDEX "ContextDocument_orgId_idx" ON "ContextDocument"("orgId");

-- CreateIndex
CREATE INDEX "Domain_orgId_idx" ON "Domain"("orgId");

-- CreateIndex
CREATE INDEX "InterviewSession_orgId_idx" ON "InterviewSession"("orgId");

-- CreateIndex
CREATE INDEX "KnowledgeBase_orgId_idx" ON "KnowledgeBase"("orgId");

-- CreateIndex
CREATE INDEX "Persona_orgId_idx" ON "Persona"("orgId");

-- CreateIndex
CREATE INDEX "SpecDraft_orgId_idx" ON "SpecDraft"("orgId");

-- CreateIndex
CREATE INDEX "SpecVersion_orgId_idx" ON "SpecVersion"("orgId");

-- CreateIndex
CREATE INDEX "Voice_orgId_idx" ON "Voice"("orgId");

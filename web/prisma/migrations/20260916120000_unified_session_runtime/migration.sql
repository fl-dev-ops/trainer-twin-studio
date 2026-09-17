-- Stable scenario deployments.
CREATE TABLE "Deployment" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "publicKey" TEXT NOT NULL,
  "secretKeyHash" TEXT,
  "allowedModes" TEXT NOT NULL DEFAULT 'chat,voice',
  "allowedOrigins" JSONB,
  "status" TEXT NOT NULL DEFAULT 'active',
  "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 30,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Deployment_publicKey_key" ON "Deployment"("publicKey");
CREATE UNIQUE INDEX "Deployment_secretKeyHash_key" ON "Deployment"("secretKeyHash");
CREATE UNIQUE INDEX "Deployment_orgId_agentId_key" ON "Deployment"("orgId", "agentId");
CREATE INDEX "Deployment_orgId_status_idx" ON "Deployment"("orgId", "status");
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "Deployment" ("id", "orgId", "agentId", "publicKey")
SELECT
  'dep_' || SUBSTRING(MD5("id" || RANDOM()::text) FROM 1 FOR 20),
  "orgId",
  "id",
  'tt_pub_' || SUBSTRING(MD5("id" || RANDOM()::text) || MD5(RANDOM()::text) FROM 1 FOR 32)
FROM "Agent"
WHERE "orgId" IS NOT NULL;

-- Assignments are invitations, not pre-created interview sessions.
DROP TRIGGER IF EXISTS "RolePlayAssignment_org_check" ON "RolePlayAssignment";
ALTER TABLE "RolePlayAssignment"
  ADD COLUMN "deploymentId" TEXT,
  ADD COLUMN "shareCode" TEXT,
  ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'voice',
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "usedAt" TIMESTAMP(3);

UPDATE "RolePlayAssignment" AS assignment
SET
  "deploymentId" = deployment."id",
  "shareCode" = COALESCE(
    (SELECT session."shareCode" FROM "InterviewSession" session WHERE session."id" = assignment."sessionId"),
    SUBSTRING(MD5(assignment."id" || RANDOM()::text) || MD5(RANDOM()::text) FROM 1 FOR 18)
  ),
  "status" = CASE
    WHEN (SELECT session."status" FROM "InterviewSession" session WHERE session."id" = assignment."sessionId") IN ('active', 'completed', 'abandoned') THEN 'used'
    WHEN (SELECT session."status" FROM "InterviewSession" session WHERE session."id" = assignment."sessionId") = 'revoked' THEN 'cancelled'
    ELSE 'pending'
  END,
  "usedAt" = CASE
    WHEN (SELECT session."status" FROM "InterviewSession" session WHERE session."id" = assignment."sessionId") IN ('active', 'completed', 'abandoned')
    THEN (SELECT session."startedAt" FROM "InterviewSession" session WHERE session."id" = assignment."sessionId")
    ELSE NULL
  END,
  "expiresAt" = assignment."assignedAt" + INTERVAL '30 days'
FROM "Deployment" deployment
WHERE deployment."agentId" = assignment."agentId";

ALTER TABLE "InterviewSession"
  ADD COLUMN "deploymentId" TEXT,
  ADD COLUMN "assignmentId" TEXT,
  ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'voice',
  ADD COLUMN "activationKey" TEXT,
  ADD COLUMN "livekitRoom" TEXT,
  ADD COLUMN "livekitDispatchId" TEXT,
  ADD COLUMN "audioEgressId" TEXT,
  ADD COLUMN "videoEgressId" TEXT;

UPDATE "InterviewSession" session
SET "deploymentId" = deployment."id"
FROM "Deployment" deployment
WHERE deployment."agentId" = session."agentId";

UPDATE "InterviewSession" session
SET "assignmentId" = assignment."id"
FROM "RolePlayAssignment" assignment
WHERE assignment."sessionId" = session."id";

ALTER TABLE "RolePlayAssignment" DROP CONSTRAINT IF EXISTS "RolePlayAssignment_sessionId_fkey";
ALTER TABLE "RolePlayAssignment" DROP CONSTRAINT IF EXISTS "RolePlayAssignment_agentId_fkey";
DROP INDEX IF EXISTS "RolePlayAssignment_sessionId_key";
DROP INDEX IF EXISTS "RolePlayAssignment_agentId_memberId_key";
ALTER TABLE "RolePlayAssignment" DROP COLUMN "sessionId";
ALTER TABLE "RolePlayAssignment" DROP COLUMN "agentId";
ALTER TABLE "RolePlayAssignment" ALTER COLUMN "deploymentId" SET NOT NULL;
ALTER TABLE "RolePlayAssignment" ALTER COLUMN "shareCode" SET NOT NULL;
ALTER TABLE "RolePlayAssignment" ALTER COLUMN "expiresAt" SET NOT NULL;

CREATE UNIQUE INDEX "RolePlayAssignment_shareCode_key" ON "RolePlayAssignment"("shareCode");
CREATE UNIQUE INDEX "RolePlayAssignment_deploymentId_memberId_key" ON "RolePlayAssignment"("deploymentId", "memberId");
CREATE INDEX "RolePlayAssignment_shareCode_status_idx" ON "RolePlayAssignment"("shareCode", "status");
ALTER TABLE "RolePlayAssignment" ADD CONSTRAINT "RolePlayAssignment_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "InterviewSession_activationKey_key" ON "InterviewSession"("activationKey");
CREATE INDEX "InterviewSession_deploymentId_idx" ON "InterviewSession"("deploymentId");
CREATE INDEX "InterviewSession_assignmentId_idx" ON "InterviewSession"("assignmentId");
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "RolePlayAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION enforce_assignment_org() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Deployment" WHERE id = NEW."deploymentId" AND "orgId" = NEW."orgId") THEN
    RAISE EXCEPTION 'Assignment deployment must belong to the same organization';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "member" WHERE id = NEW."memberId" AND "organizationId" = NEW."orgId") THEN
    RAISE EXCEPTION 'Assignment member must belong to the same organization';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RolePlayAssignment_org_check"
BEFORE INSERT OR UPDATE OF "orgId", "memberId", "deploymentId" ON "RolePlayAssignment"
FOR EACH ROW EXECUTE FUNCTION enforce_assignment_org();

-- Browser-executed workspace commands, durable across refresh and reconnect.
CREATE TABLE "WorkspaceCommand" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "tool" TEXT NOT NULL,
  "input" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "result" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "WorkspaceCommand_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WorkspaceCommand_sessionId_status_createdAt_idx" ON "WorkspaceCommand"("sessionId", "status", "createdAt");
ALTER TABLE "WorkspaceCommand" ADD CONSTRAINT "WorkspaceCommand_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

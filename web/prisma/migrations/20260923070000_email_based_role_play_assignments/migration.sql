-- Normalize installations where the prior repair migration restored the legacy
-- agent/session assignment shape after deployments had already been introduced.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'RolePlayAssignment'
      AND column_name = 'agentId'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'RolePlayAssignment'
      AND column_name = 'deploymentId'
  ) THEN
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
    WHERE deployment."orgId" = assignment."orgId"
      AND deployment."agentId" = assignment."agentId";

    UPDATE "InterviewSession" AS session
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
    ALTER TABLE "RolePlayAssignment" ADD CONSTRAINT "RolePlayAssignment_deploymentId_fkey"
      FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

    ALTER TABLE "InterviewSession" DROP CONSTRAINT IF EXISTS "InterviewSession_assignmentId_fkey";
    ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_assignmentId_fkey"
      FOREIGN KEY ("assignmentId") REFERENCES "RolePlayAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Learners receive a practice link and authenticate without joining the trainer's organization.
ALTER TABLE "RolePlayAssignment"
  ADD COLUMN "recipientEmail" TEXT;

-- Preserve existing member-backed assignments.
UPDATE "RolePlayAssignment" AS assignment
SET "recipientEmail" = LOWER("user"."email")
FROM "member"
JOIN "user" ON "user"."id" = "member"."userId"
WHERE assignment."memberId" = "member"."id";

ALTER TABLE "RolePlayAssignment"
  ALTER COLUMN "recipientEmail" SET NOT NULL,
  ALTER COLUMN "memberId" DROP NOT NULL;

CREATE INDEX "RolePlayAssignment_deploymentId_recipientEmail_idx"
  ON "RolePlayAssignment"("deploymentId", "recipientEmail");

-- Keep deployment tenancy enforcement while allowing learners without Member rows.
CREATE OR REPLACE FUNCTION enforce_assignment_org() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Deployment" WHERE id = NEW."deploymentId" AND "orgId" = NEW."orgId") THEN
    RAISE EXCEPTION 'Assignment deployment must belong to the same organization';
  END IF;
  IF NEW."memberId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "member" WHERE id = NEW."memberId" AND "organizationId" = NEW."orgId"
  ) THEN
    RAISE EXCEPTION 'Assignment member must belong to the same organization';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "RolePlayAssignment_org_check" ON "RolePlayAssignment";
CREATE TRIGGER "RolePlayAssignment_org_check"
BEFORE INSERT OR UPDATE OF "orgId", "memberId", "deploymentId" ON "RolePlayAssignment"
FOR EACH ROW EXECUTE FUNCTION enforce_assignment_org();

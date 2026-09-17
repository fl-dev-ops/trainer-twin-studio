-- Some environments recorded the agent-based assignment migration as applied
-- while retaining an older deployment-based table. Refuse to discard real data.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'RolePlayAssignment'
      AND column_name = 'deploymentId'
  ) AND EXISTS (SELECT 1 FROM "RolePlayAssignment") THEN
    RAISE EXCEPTION 'Cannot repair non-empty legacy RolePlayAssignment table';
  END IF;
END $$;

DROP TABLE IF EXISTS "RolePlayAssignment" CASCADE;

CREATE TABLE "RolePlayAssignment" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "assignedByUserId" TEXT NOT NULL,
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sessionId" TEXT,
  CONSTRAINT "RolePlayAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RolePlayAssignment_sessionId_key" ON "RolePlayAssignment"("sessionId");
CREATE UNIQUE INDEX "RolePlayAssignment_agentId_memberId_key" ON "RolePlayAssignment"("agentId", "memberId");
CREATE INDEX "RolePlayAssignment_orgId_memberId_idx" ON "RolePlayAssignment"("orgId", "memberId");

ALTER TABLE "RolePlayAssignment"
  ADD CONSTRAINT "RolePlayAssignment_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RolePlayAssignment"
  ADD CONSTRAINT "RolePlayAssignment_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RolePlayAssignment"
  ADD CONSTRAINT "RolePlayAssignment_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RolePlayAssignment"
  ADD CONSTRAINT "RolePlayAssignment_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "InterviewSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

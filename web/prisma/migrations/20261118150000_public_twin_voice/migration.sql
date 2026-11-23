ALTER TABLE "InterviewSession" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "InterviewSession"
  ADD COLUMN "anonymousId" TEXT,
  ADD COLUMN "anonymousName" TEXT,
  ADD COLUMN "anonymousIpHash" TEXT,
  ADD CONSTRAINT session_owner_kind CHECK (
    ("userId" IS NOT NULL AND "anonymousId" IS NULL AND "anonymousName" IS NULL AND "anonymousIpHash" IS NULL)
    OR
    ("userId" IS NULL AND length("anonymousId") = 64 AND length("anonymousIpHash") = 64
      AND length(trim("anonymousName")) BETWEEN 1 AND 80
      AND "anonymousId" IS NOT NULL AND "anonymousIpHash" IS NOT NULL AND "anonymousName" IS NOT NULL
      AND "mode" = 'voice' AND "chargesOrg" AND "allowedSeconds" BETWEEN 1 AND 300
      AND "allowedSeconds" IS NOT NULL AND "assignmentId" IS NULL AND "twinAssignmentId" IS NULL
      AND "contextId" IS NULL)
  );
CREATE INDEX "InterviewSession_orgId_anonymousIpHash_createdAt_idx"
  ON "InterviewSession"("orgId", "anonymousIpHash", "createdAt");
CREATE INDEX "InterviewSession_orgId_anonymousId_createdAt_idx"
  ON "InterviewSession"("orgId", "anonymousId", "createdAt");

CREATE OR REPLACE FUNCTION enforce_interview_session_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Agent" WHERE id = NEW."agentId" AND "orgId" = NEW."orgId") THEN
    RAISE EXCEPTION 'Session agent must belong to the same organization';
  END IF;
  IF NEW."anonymousId" IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM "Agent" WHERE id = NEW."agentId" AND kind = 'TWIN') THEN
      RAISE EXCEPTION 'Anonymous sessions are only for twins';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."assignmentId" IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM "RolePlayAssignment" a
      JOIN "Deployment" d ON d.id = a."deploymentId"
      JOIN "member" m ON m.id = a."memberId"
      WHERE a.id = NEW."assignmentId" AND a."orgId" = NEW."orgId"
        AND d."orgId" = NEW."orgId" AND d."agentId" = NEW."agentId"
        AND (NEW."deploymentId" IS NULL OR NEW."deploymentId" = a."deploymentId")
        AND m."userId" = NEW."userId" AND m."organizationId" = NEW."orgId"
    ) THEN
      RAISE EXCEPTION 'Session assignment must belong to the user and organization';
    END IF;
  ELSIF NEW."twinAssignmentId" IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM "TwinAssignment" t
      WHERE t.id = NEW."twinAssignmentId" AND t."orgId" = NEW."orgId"
        AND t."agentId" = NEW."agentId" AND t."userId" = NEW."userId"
    ) THEN
      RAISE EXCEPTION 'Session twin assignment must belong to the user and organization';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM "member" WHERE "userId" = NEW."userId" AND "organizationId" = NEW."orgId"
  ) THEN
    RAISE EXCEPTION 'Session user must belong to the same organization';
  END IF;
  IF NEW."contextId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ContextDocument" WHERE id = NEW."contextId" AND "orgId" = NEW."orgId"
  ) THEN
    RAISE EXCEPTION 'Session context must belong to the same organization';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION tt_twin_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT kind FROM "Agent" WHERE id = NEW."agentId") = 'TWIN' THEN
    IF NEW."mode" <> 'voice' THEN
      RAISE EXCEPTION 'Twin sessions are voice only';
    END IF;
    IF NEW."anonymousId" IS NOT NULL THEN
      IF TG_OP = 'INSERT' AND NOT EXISTS (
        SELECT 1 FROM "Agent"
        WHERE id = NEW."agentId" AND "archivedAt" IS NULL
          AND data->'publicAccess'->>'enabled' = 'true'
          AND (data->'publicAccess'->>'maxSeconds')::int >= NEW."allowedSeconds"
      ) THEN
        RAISE EXCEPTION 'Public access is not enabled for this twin';
      END IF;
    ELSIF NEW."twinAssignmentId" IS NULL AND NOT EXISTS (
      SELECT 1 FROM "member" WHERE "userId" = NEW."userId" AND "organizationId" = NEW."orgId"
        AND "role" IN ('admin', 'team')
    ) THEN
      RAISE EXCEPTION 'Twin sessions need a twin assignment unless the user is admin or team';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER "InterviewSession_org_check" ON "InterviewSession";
CREATE TRIGGER "InterviewSession_org_check"
  BEFORE INSERT OR UPDATE OF "orgId", "userId", "agentId", "contextId", "assignmentId", "deploymentId", "twinAssignmentId", "anonymousId"
  ON "InterviewSession" FOR EACH ROW EXECUTE FUNCTION enforce_interview_session_org();

-- Email-assigned learners are not organization members. Keep tenant boundaries
-- while allowing a session tied to an assignment belonging to that learner.
CREATE OR REPLACE FUNCTION enforce_interview_session_org() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Agent" WHERE id = NEW."agentId" AND "orgId" = NEW."orgId") THEN
    RAISE EXCEPTION 'Session agent must belong to the same organization';
  END IF;

  IF NEW."assignmentId" IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM "RolePlayAssignment" a
      JOIN "Deployment" d ON d.id = a."deploymentId"
      JOIN "user" u ON u.id = NEW."userId"
      LEFT JOIN "member" m ON m.id = a."memberId"
      WHERE a.id = NEW."assignmentId"
        AND a."orgId" = NEW."orgId"
        AND d."orgId" = NEW."orgId"
        AND d."agentId" = NEW."agentId"
        AND (NEW."deploymentId" IS NULL OR NEW."deploymentId" = a."deploymentId")
        AND (
          (a."memberId" IS NOT NULL AND m."userId" = NEW."userId" AND m."organizationId" = NEW."orgId")
          OR (a."memberId" IS NULL AND LOWER(a."recipientEmail") = LOWER(u.email))
        )
    ) THEN
      RAISE EXCEPTION 'Session assignment must belong to the user and organization';
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
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER "InterviewSession_org_check" ON "InterviewSession";
CREATE TRIGGER "InterviewSession_org_check"
BEFORE INSERT OR UPDATE OF "orgId", "userId", "agentId", "contextId", "assignmentId", "deploymentId" ON "InterviewSession"
FOR EACH ROW EXECUTE FUNCTION enforce_interview_session_org();

ALTER TABLE "InterviewSession"
  ADD COLUMN "feedbackRating" INTEGER,
  ADD COLUMN "feedbackNote" TEXT,
  ADD CONSTRAINT "InterviewSession_feedbackRating_check" CHECK ("feedbackRating" BETWEEN 1 AND 5);

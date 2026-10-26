-- Twin access (plans/twin-roleplay-db-split.md §12). Twins are assigned per user with a minutes budget
-- (one budget per twin agent) and can be shared through a common link; role plays keep RolePlayAssignment.
-- Twin sessions are voice only. Admin and team (studio roles) use twins without an assignment or limit.
-- CHECKs, triggers and functions are not tracked by Prisma; they live only here.

-- AlterTable
ALTER TABLE "InterviewSession" ADD COLUMN     "twinAssignmentId" TEXT;

-- CreateTable
CREATE TABLE "TwinShareLink" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "minutesPerUser" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TwinShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TwinAssignment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "userId" TEXT,
    "minutesLimit" INTEGER NOT NULL,
    "shareCode" TEXT NOT NULL,
    "shareLinkId" TEXT,
    "assignedByUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TwinAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TwinShareLink_code_key" ON "TwinShareLink"("code");

-- CreateIndex
CREATE INDEX "TwinShareLink_agentId_idx" ON "TwinShareLink"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "TwinAssignment_shareCode_key" ON "TwinAssignment"("shareCode");

-- CreateIndex
CREATE INDEX "TwinAssignment_orgId_status_idx" ON "TwinAssignment"("orgId", "status");

-- CreateIndex
CREATE INDEX "TwinAssignment_userId_idx" ON "TwinAssignment"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TwinAssignment_agentId_recipientEmail_key" ON "TwinAssignment"("agentId", "recipientEmail");

-- CreateIndex
CREATE INDEX "InterviewSession_twinAssignmentId_idx" ON "InterviewSession"("twinAssignmentId");

-- AddForeignKey
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_twinAssignmentId_fkey" FOREIGN KEY ("twinAssignmentId") REFERENCES "TwinAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwinShareLink" ADD CONSTRAINT "TwinShareLink_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwinShareLink" ADD CONSTRAINT "TwinShareLink_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwinAssignment" ADD CONSTRAINT "TwinAssignment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwinAssignment" ADD CONSTRAINT "TwinAssignment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwinAssignment" ADD CONSTRAINT "TwinAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwinAssignment" ADD CONSTRAINT "TwinAssignment_shareLinkId_fkey" FOREIGN KEY ("shareLinkId") REFERENCES "TwinShareLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===== checks =====
ALTER TABLE "TwinShareLink"  ADD CONSTRAINT "TwinShareLink_minutesPerUser_check" CHECK ("minutesPerUser" > 0);
ALTER TABLE "TwinShareLink"  ADD CONSTRAINT "TwinShareLink_status_check" CHECK ("status" IN ('active', 'disabled'));
ALTER TABLE "TwinAssignment" ADD CONSTRAINT "TwinAssignment_minutesLimit_check" CHECK ("minutesLimit" > 0);
ALTER TABLE "TwinAssignment" ADD CONSTRAINT "TwinAssignment_status_check" CHECK ("status" IN ('active', 'revoked'));
ALTER TABLE "TwinAssignment" ADD CONSTRAINT "TwinAssignment_recipientEmail_check" CHECK ("recipientEmail" = lower("recipientEmail"));
ALTER TABLE "InterviewSession" ADD CONSTRAINT session_one_assignment_kind
  CHECK ("assignmentId" IS NULL OR "twinAssignmentId" IS NULL);

-- ===== session access rule first, so the conversion below runs under it =====
-- The existing trigger calls enforce_interview_session_org() by name; replacing the function updates it.
-- Existing session org rule, extended: a twin assignment also proves access (link joiners may not be members).
CREATE OR REPLACE FUNCTION enforce_interview_session_org() RETURNS trigger LANGUAGE plpgsql AS $$
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
  ELSIF NEW."twinAssignmentId" IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM "TwinAssignment" t
      JOIN "user" u ON u.id = NEW."userId"
      WHERE t.id = NEW."twinAssignmentId"
        AND t."orgId" = NEW."orgId"
        AND t."agentId" = NEW."agentId"
        AND (t."userId" = NEW."userId" OR (t."userId" IS NULL AND t."recipientEmail" = LOWER(u.email)))
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
DROP TRIGGER "InterviewSession_org_check" ON "InterviewSession";
CREATE TRIGGER "InterviewSession_org_check" BEFORE INSERT OR UPDATE OF "orgId", "userId", "agentId", "contextId", "assignmentId", "deploymentId", "twinAssignmentId"
  ON "InterviewSession" FOR EACH ROW EXECUTE FUNCTION enforce_interview_session_org();

-- ===== move existing invites on twin agents to twin assignments (30 minutes, same link) =====
INSERT INTO "TwinAssignment" ("id", "orgId", "agentId", "recipientEmail", "userId", "minutesLimit", "shareCode", "assignedByUserId", "status", "createdAt", "updatedAt")
SELECT r."id", r."orgId", d."agentId", lower(r."recipientEmail"), m."userId", 30, r."shareCode", r."assignedByUserId",
       CASE WHEN r."status" IN ('pending', 'used') THEN 'active' ELSE 'revoked' END, r."assignedAt", now()
FROM "RolePlayAssignment" r
JOIN "Deployment" d ON d."id" = r."deploymentId"
JOIN "Agent" a ON a."id" = d."agentId"
LEFT JOIN "member" m ON m."id" = r."memberId"
WHERE a."kind" = 'TWIN';
UPDATE "InterviewSession" s SET "twinAssignmentId" = s."assignmentId", "assignmentId" = NULL
FROM "TwinAssignment" t WHERE t."id" = s."assignmentId";
DELETE FROM "RolePlayAssignment" r USING "Deployment" d, "Agent" a
WHERE d."id" = r."deploymentId" AND a."id" = d."agentId" AND a."kind" = 'TWIN';

-- Learners whose only org match is a twin assignment get role 'user' there (same rule as org_roles).
INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt")
SELECT gen_random_uuid()::text, first."orgId", first."userId", 'user', first."at"
FROM (
  SELECT DISTINCT ON (u."id") u."id" AS "userId", t."orgId", t."createdAt" AS "at"
  FROM "TwinAssignment" t
  JOIN "user" u ON u."id" = t."userId" OR (t."userId" IS NULL AND lower(u."email") = t."recipientEmail")
  WHERE t."status" = 'active' AND NOT EXISTS (SELECT 1 FROM "member" x WHERE x."userId" = u."id")
  ORDER BY u."id", t."createdAt", t."orgId"
) first;

-- ===== rules for new writes (after the conversion, so history is not re-checked) =====
-- Role-play invites only on role plays.
CREATE FUNCTION tt_roleplay_assignment_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Deployment" d JOIN "Agent" a ON a.id = d."agentId"
                 WHERE d.id = NEW."deploymentId" AND a.kind = 'ROLEPLAY') THEN
    RAISE EXCEPTION 'Role-play assignments are only for role plays';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER roleplay_assignment_kind BEFORE INSERT OR UPDATE OF "deploymentId" ON "RolePlayAssignment"
  FOR EACH ROW EXECUTE FUNCTION tt_roleplay_assignment_kind();

-- Twin assignments and links only on twins of the same org; a link-made assignment is for that link's twin.
CREATE FUNCTION tt_twin_access_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Agent" WHERE id = NEW."agentId" AND kind = 'TWIN' AND "orgId" = NEW."orgId") THEN
    RAISE EXCEPTION '% must point at a twin in the same organization', TG_TABLE_NAME;
  END IF;
  -- Nested IF: PL/pgSQL resolves NEW."shareLinkId" even inside AND, and TwinShareLink rows have no such field.
  IF TG_TABLE_NAME = 'TwinAssignment' THEN
    IF NEW."shareLinkId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "TwinShareLink" WHERE id = NEW."shareLinkId" AND "agentId" = NEW."agentId") THEN
      RAISE EXCEPTION 'Twin assignment share link must be for the same twin';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER twin_share_link_kind BEFORE INSERT OR UPDATE OF "agentId", "orgId" ON "TwinShareLink"
  FOR EACH ROW EXECUTE FUNCTION tt_twin_access_kind();
CREATE TRIGGER twin_assignment_kind BEFORE INSERT OR UPDATE OF "agentId", "orgId", "shareLinkId" ON "TwinAssignment"
  FOR EACH ROW EXECUTE FUNCTION tt_twin_access_kind();

-- Twin sessions: voice only (LiveKit); without a twin assignment only admin or team may run one (no limits).
CREATE FUNCTION tt_twin_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT kind FROM "Agent" WHERE id = NEW."agentId") = 'TWIN' THEN
    IF NEW."mode" <> 'voice' THEN
      RAISE EXCEPTION 'Twin sessions are voice only';
    END IF;
    IF NEW."twinAssignmentId" IS NULL AND NOT EXISTS (
      SELECT 1 FROM "member" WHERE "userId" = NEW."userId" AND "organizationId" = NEW."orgId"
        AND "role" IN ('admin', 'team')) THEN
      RAISE EXCEPTION 'Twin sessions need a twin assignment unless the user is admin or team';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER twin_session BEFORE INSERT OR UPDATE OF "agentId", "mode", "twinAssignmentId", "userId", "orgId" ON "InterviewSession"
  FOR EACH ROW EXECUTE FUNCTION tt_twin_session();

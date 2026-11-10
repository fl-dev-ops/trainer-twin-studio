-- People first (specs/people.md): an account, then an org member, then an assignment. Assignments point at the
-- member (twins: userId, which must be a member of the twin's org; role plays: memberId), never at an email.
-- Backfills the old email-only rows first, so it is safe on any data. One transaction: all of it or none.

BEGIN;

-- 1. One member row per account per org: keep the highest role (admin, team, user), oldest first; role-play
--    assignments on a removed row move to the kept one (a second one for the same role play is dropped below).
CREATE TEMP TABLE member_keep ON COMMIT DROP AS
  SELECT id, "organizationId", "userId",
         first_value(id) OVER (PARTITION BY "organizationId", "userId"
           ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'team' THEN 1 ELSE 2 END, "createdAt", id) AS keep_id
  FROM member;
UPDATE "RolePlayAssignment" a SET "memberId" = k.keep_id
  FROM member_keep k WHERE a."memberId" = k.id AND k.id <> k.keep_id
    AND NOT EXISTS (SELECT 1 FROM "RolePlayAssignment" b WHERE b."deploymentId" = a."deploymentId" AND b."memberId" = k.keep_id);
DELETE FROM "RolePlayAssignment" a USING member_keep k WHERE a."memberId" = k.id AND k.id <> k.keep_id;
DELETE FROM member m USING member_keep k WHERE m.id = k.id AND k.id <> k.keep_id;
CREATE UNIQUE INDEX "member_organizationId_userId_key" ON "member"("organizationId", "userId");

-- 2. Everyone who was given something by email, or holds a pending invitation, gets an account and a membership.
CREATE TEMP TABLE people_needed ON COMMIT DROP AS
  SELECT DISTINCT lower(email) AS email, "orgId", role FROM (
    SELECT coalesce(u.email, t."recipientEmail") AS email, t."orgId", 'user' AS role
      FROM "TwinAssignment" t LEFT JOIN "user" u ON u.id = t."userId"
    UNION ALL
    SELECT r."recipientEmail", r."orgId", 'user' FROM "RolePlayAssignment" r WHERE r."memberId" IS NULL
    UNION ALL
    SELECT i.email, i."organizationId", i.role FROM invitation i WHERE i.status = 'pending'
  ) x WHERE email IS NOT NULL AND email <> '';

INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, split_part(email, '@', 1), email, false, now(), now()
  FROM (SELECT DISTINCT email FROM people_needed) p
  WHERE NOT EXISTS (SELECT 1 FROM "user" u WHERE lower(u.email) = p.email);

-- Highest role asked for wins; a second admin becomes team (one admin per org).
INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
  SELECT gen_random_uuid()::text, n."orgId", u.id,
         CASE WHEN n.role = 'admin' AND EXISTS (SELECT 1 FROM member a WHERE a."organizationId" = n."orgId" AND a.role = 'admin')
              THEN 'team' ELSE n.role END,
         now()
  FROM (SELECT email, "orgId", (array_agg(role ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'team' THEN 1 ELSE 2 END))[1] AS role
        FROM people_needed GROUP BY email, "orgId") n
  JOIN "user" u ON lower(u.email) = n.email
  WHERE NOT EXISTS (SELECT 1 FROM member m WHERE m."organizationId" = n."orgId" AND m."userId" = u.id);

UPDATE invitation SET status = 'accepted' WHERE status = 'pending';

-- 3. Link the email-only assignments to their person. A role play given twice to the same person keeps one row
--    (pending/used before cancelled/expired, newest first); its sessions move to the kept row.
UPDATE "TwinAssignment" t SET "userId" = u.id FROM "user" u WHERE t."userId" IS NULL AND lower(u.email) = t."recipientEmail";

CREATE TEMP TABLE rp_owner ON COMMIT DROP AS
  SELECT r.id, coalesce(r."memberId", m.id) AS member_id, r."deploymentId",
         row_number() OVER (PARTITION BY r."deploymentId", coalesce(r."memberId", m.id)
           ORDER BY CASE WHEN r.status IN ('pending', 'used') THEN 0 ELSE 1 END, r."memberId" IS NULL, r."assignedAt" DESC, r.id) AS rank
  FROM "RolePlayAssignment" r
  LEFT JOIN "user" u ON lower(u.email) = lower(r."recipientEmail")
  LEFT JOIN member m ON m."userId" = u.id AND m."organizationId" = r."orgId";
UPDATE "InterviewSession" s SET "assignmentId" = keep.id
  FROM rp_owner drop_row JOIN rp_owner keep ON keep."deploymentId" = drop_row."deploymentId" AND keep.member_id = drop_row.member_id AND keep.rank = 1
  WHERE s."assignmentId" = drop_row.id AND drop_row.rank > 1;
DELETE FROM "RolePlayAssignment" r USING rp_owner o WHERE r.id = o.id AND o.rank > 1;
UPDATE "RolePlayAssignment" r SET "memberId" = o.member_id FROM rp_owner o WHERE r.id = o.id AND r."memberId" IS NULL;

-- 3b. Admin and team hold no learner assignments (they practise from the org's credits): left over from before they
--     joined the studio. Their sessions keep their history (the session's link to the assignment is cleared).
DELETE FROM "TwinAssignment" t USING member m
  WHERE m."organizationId" = t."orgId" AND m."userId" = t."userId" AND m.role IN ('admin', 'team');
DELETE FROM "RolePlayAssignment" r USING member m
  WHERE m.id = r."memberId" AND m.role IN ('admin', 'team');

-- 4. The session check no longer matches assignments by email.
CREATE OR REPLACE FUNCTION enforce_interview_session_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Agent" WHERE id = NEW."agentId" AND "orgId" = NEW."orgId") THEN
    RAISE EXCEPTION 'Session agent must belong to the same organization';
  END IF;

  IF NEW."assignmentId" IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM "RolePlayAssignment" a
      JOIN "Deployment" d ON d.id = a."deploymentId"
      JOIN "member" m ON m.id = a."memberId"
      WHERE a.id = NEW."assignmentId"
        AND a."orgId" = NEW."orgId"
        AND d."orgId" = NEW."orgId"
        AND d."agentId" = NEW."agentId"
        AND (NEW."deploymentId" IS NULL OR NEW."deploymentId" = a."deploymentId")
        AND m."userId" = NEW."userId" AND m."organizationId" = NEW."orgId"
    ) THEN
      RAISE EXCEPTION 'Session assignment must belong to the user and organization';
    END IF;
  ELSIF NEW."twinAssignmentId" IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM "TwinAssignment" t
      WHERE t.id = NEW."twinAssignmentId" AND t."orgId" = NEW."orgId" AND t."agentId" = NEW."agentId" AND t."userId" = NEW."userId"
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

-- 5. The rules, enforced: assignments always point at a member; no email columns left to match on.
ALTER TABLE "TwinAssignment" DROP CONSTRAINT "TwinAssignment_userId_fkey";
ALTER TABLE "TwinAssignment" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "TwinAssignment" ADD CONSTRAINT "TwinAssignment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"(id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TwinAssignment" ADD CONSTRAINT "TwinAssignment_orgId_userId_fkey"
  FOREIGN KEY ("orgId", "userId") REFERENCES member("organizationId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
DROP INDEX "TwinAssignment_agentId_recipientEmail_key";
ALTER TABLE "TwinAssignment" DROP COLUMN "recipientEmail";
CREATE UNIQUE INDEX "TwinAssignment_agentId_userId_key" ON "TwinAssignment"("agentId", "userId");

ALTER TABLE "RolePlayAssignment" ALTER COLUMN "memberId" SET NOT NULL;
DROP INDEX "RolePlayAssignment_deploymentId_recipientEmail_idx";
ALTER TABLE "RolePlayAssignment" DROP COLUMN "recipientEmail";

-- 6. Org credits emails: grants already there are not announced again (only new ones get the admin an email).
ALTER TABLE "OrgBilling" ADD COLUMN "announcedGrantIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
UPDATE "OrgBilling" SET "announcedGrantIds" = ARRAY(SELECT jsonb_array_elements(grants::jsonb)->>'id');

COMMIT;

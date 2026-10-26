-- Org roles: admin / team / user (plans/twin-roleplay-db-split.md §13).
-- admin and team run the studio with identical access; user only practises (twin / role play).
-- One role per member. CHECKs are not tracked by Prisma; they live only here.

-- 1. rename existing roles: owner/admin -> admin, everything else (member) -> user
UPDATE "member" SET "role" = CASE
  WHEN "role" ~* '(^|,)\s*(owner|admin)\s*(,|$)' THEN 'admin'
  WHEN "role" ~* '(^|,)\s*team\s*(,|$)' THEN 'team'
  ELSE 'user' END;
UPDATE "invitation" SET "role" = CASE
  WHEN "role" ~* '(^|,)\s*(owner|admin)\s*(,|$)' THEN 'admin'
  WHEN "role" ~* '(^|,)\s*team\s*(,|$)' THEN 'team'
  ELSE 'user' END;

-- 2. lock down
ALTER TABLE "member"     ALTER COLUMN "role" SET DEFAULT 'user';
ALTER TABLE "invitation" ALTER COLUMN "role" SET DEFAULT 'user';
ALTER TABLE "invitation" ALTER COLUMN "role" SET NOT NULL;
ALTER TABLE "member"     ADD CONSTRAINT member_role_check     CHECK ("role" IN ('admin', 'team', 'user'));
ALTER TABLE "invitation" ADD CONSTRAINT invitation_role_check CHECK ("role" IN ('admin', 'team', 'user'));

-- 3. learners with no member row get role 'user' in their first (oldest) org match.
-- Same rule as lib/org-lock.ts homeOrgsByEmail: earliest live role-play invite (pending/used) or session.
-- Only people who already have a user row; invite-only emails get theirs on first sign-in (app).
-- Twin assignments are added to this rule by migration twin_access (none exist before it).
INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt")
SELECT gen_random_uuid()::text, first."orgId", first."userId", 'user', first."at"
FROM (
  SELECT DISTINCT ON (m."userId") m."userId", m."orgId", m."at"
  FROM (
    SELECT s."userId", s."orgId", s."createdAt" AS "at" FROM "InterviewSession" s
    UNION ALL
    SELECT u."id", r."orgId", r."assignedAt" FROM "RolePlayAssignment" r
      JOIN "user" u ON lower(u."email") = lower(r."recipientEmail") WHERE r."status" IN ('pending', 'used')
  ) m
  WHERE NOT EXISTS (SELECT 1 FROM "member" x WHERE x."userId" = m."userId")
  ORDER BY m."userId", m."at", m."orgId"
) first;

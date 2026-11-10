-- Run only against a disposable database with all Prisma migrations applied.
-- Twin access rules (migration 20261027020000_twin_access).
BEGIN;
INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('ta-org', 'TA', 'ta-org', NOW());
INSERT INTO "user" (id, name, email, "createdAt", "updatedAt") VALUES
  ('ta-admin', 'Admin', 'ta-admin@example.com', NOW(), NOW()),
  ('ta-team', 'Team', 'ta-team@example.com', NOW(), NOW()),
  ('ta-user', 'User', 'ta-user@example.com', NOW(), NOW()),
  ('ta-learner', 'Learner', 'ta-learner@example.com', NOW(), NOW()),
  ('ta-other', 'Other', 'ta-other@example.com', NOW(), NOW());
INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES
  ('ta-m1', 'ta-org', 'ta-admin', 'admin', NOW()),
  ('ta-m2', 'ta-org', 'ta-team', 'team', NOW()),
  ('ta-m3', 'ta-org', 'ta-user', 'user', NOW()),
  ('ta-m4', 'ta-org', 'ta-learner', 'user', NOW());
INSERT INTO "Persona" (id, "orgId", slug, name, data, "isOwn", "updatedAt") VALUES ('ta-own', 'ta-org', 'ta-own', 'Own', '{}', true, NOW());
INSERT INTO "Agent" (id, "orgId", slug, name, "personaId", kind, data, "updatedAt") VALUES
  ('ta-twin', 'ta-org', 'ta-twin', 'Twin', 'ta-own', 'TWIN', '{}', NOW()),
  ('ta-skill', 'ta-org', 'ta-skill', 'Skill', 'ta-own', 'TWIN', '{}', NOW()),
  ('ta-rp', 'ta-org', 'ta-rp', 'Role play', 'ta-own', 'ROLEPLAY', '{}', NOW());
INSERT INTO "Deployment" (id, "orgId", "agentId", "publicKey", "updatedAt") VALUES
  ('ta-dtwin', 'ta-org', 'ta-twin', 'ta-pk1', NOW()),
  ('ta-drp', 'ta-org', 'ta-rp', 'ta-pk2', NOW());
INSERT INTO "TwinShareLink" (id, "orgId", "agentId", code, "minutesPerUser", "updatedAt") VALUES ('ta-link', 'ta-org', 'ta-twin', 'ta-link', 20, NOW());
INSERT INTO "TwinAssignment" (id, "orgId", "agentId", "userId", "minutesLimit", "shareCode", "shareLinkId", "updatedAt")
  VALUES ('ta-a', 'ta-org', 'ta-twin', 'ta-learner', 30, 'ta-a', 'ta-link', NOW());
-- The member may hold both a role-play assignment and a skill twin; their credits are shared.
INSERT INTO "RolePlayAssignment" (id, "orgId", "deploymentId", "memberId", "assignedByUserId", "shareCode", "expiresAt")
  VALUES ('ta-r', 'ta-org', 'ta-drp', 'ta-m4', 'ta-admin', 'ta-r', NOW() + INTERVAL '1 day');
INSERT INTO "TwinAssignment" (id, "orgId", "agentId", "userId", "minutesLimit", "shareCode", "updatedAt")
  VALUES ('ta-a2', 'ta-org', 'ta-skill', 'ta-learner', 10, 'ta-a2', NOW());

CREATE FUNCTION pg_temp.sess(sid text, uid text, agent text, md text, twin text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO "InterviewSession" (id, "orgId", "userId", "agentId", "shareCode", "personaSlug", "personaVersion", "agentSlug", "agentVersion", mode, "twinAssignmentId", "startedAt", "endedAt")
  VALUES (sid, 'ta-org', uid, agent, sid, 'p', 1, agent, 1, md, twin, NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '4 minutes') $$;

-- allowed: admin and team without an assignment; a member learner with their own assignment
SELECT pg_temp.sess('ta-s-admin', 'ta-admin', 'ta-twin', 'voice', NULL);
SELECT pg_temp.sess('ta-s-team', 'ta-team', 'ta-twin', 'voice', NULL);
SELECT pg_temp.sess('ta-s-learner', 'ta-learner', 'ta-twin', 'voice', 'ta-a');

DO $$
BEGIN
  BEGIN
    INSERT INTO "RolePlayAssignment" (id, "orgId", "deploymentId", "memberId", "assignedByUserId", "shareCode", "expiresAt")
      VALUES ('ta-x1', 'ta-org', 'ta-dtwin', 'ta-m4', 'ta-admin', 'ta-x1', NOW() + INTERVAL '1 day');
    RAISE EXCEPTION 'Role-play invite on a twin was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Role-play assignments are only for role plays' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO "TwinAssignment" (id, "orgId", "agentId", "userId", "minutesLimit", "shareCode", "updatedAt")
      VALUES ('ta-x2', 'ta-org', 'ta-rp', 'ta-learner', 30, 'ta-x2', NOW());
    RAISE EXCEPTION 'Twin assignment on a role play was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'TwinAssignment must point at a twin in the same organization' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO "TwinAssignment" (id, "orgId", "agentId", "userId", "minutesLimit", "shareCode", "shareLinkId", "updatedAt")
      VALUES ('ta-x3', 'ta-org', 'ta-skill', 'ta-learner', 30, 'ta-x3', 'ta-link', NOW());
    RAISE EXCEPTION 'Assignment from another twin''s link was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Twin assignment share link must be for the same twin' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO "TwinAssignment" (id, "orgId", "agentId", "userId", "minutesLimit", "shareCode", "updatedAt")
      VALUES ('ta-x4', 'ta-org', 'ta-twin', 'ta-learner', 5, 'ta-x4', NOW());
    RAISE EXCEPTION 'Second assignment on the same twin was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "TwinAssignment" (id, "orgId", "agentId", "userId", "minutesLimit", "shareCode", "updatedAt")
      VALUES ('ta-x5', 'ta-org', 'ta-twin', 'ta-other', 5, 'ta-x5', NOW());
    RAISE EXCEPTION 'Non-member twin assignment was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "TwinAssignment" (id, "orgId", "agentId", "userId", "minutesLimit", "shareCode", "updatedAt")
      VALUES ('ta-x6', 'ta-org', 'ta-twin', 'ta-learner', 0, 'ta-x6', NOW());
    RAISE EXCEPTION 'Zero minutes was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM pg_temp.sess('ta-x7', 'ta-admin', 'ta-twin', 'chat', NULL);
    RAISE EXCEPTION 'Twin chat session was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Twin sessions are voice only' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM pg_temp.sess('ta-x8', 'ta-user', 'ta-twin', 'voice', NULL);
    RAISE EXCEPTION 'User role without an assignment was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Twin sessions need a twin assignment unless the user is admin or team' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM pg_temp.sess('ta-x9', 'ta-other', 'ta-twin', 'voice', 'ta-a');
    RAISE EXCEPTION 'Someone else''s assignment was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Session twin assignment must belong to the user and organization' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM pg_temp.sess('ta-x10', 'ta-learner', 'ta-skill', 'voice', 'ta-a');
    RAISE EXCEPTION 'Assignment used on another twin was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Session twin assignment must belong to the user and organization' THEN RAISE; END IF;
  END;
  IF (SELECT round(sum(extract(epoch FROM ("endedAt" - "startedAt"))) / 60) FROM "InterviewSession" WHERE "twinAssignmentId" = 'ta-a') <> 6 THEN
    RAISE EXCEPTION 'Expected 6 minutes used on ta-a';
  END IF;
END $$;

-- A session never carries both assignment kinds (CHECK; triggers off to reach it).
ALTER TABLE "InterviewSession" DISABLE TRIGGER USER;
DO $$ BEGIN
  BEGIN
    UPDATE "InterviewSession" SET "assignmentId" = 'ta-r' WHERE id = 'ta-s-learner';
    RAISE EXCEPTION 'Both assignment kinds were accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;

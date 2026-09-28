-- Run only against a disposable database with all Prisma migrations applied.
BEGIN;
INSERT INTO "organization" (id, name, slug, "createdAt") VALUES
  ('test-org', 'Test', 'test-org', NOW()),
  ('test-other-org', 'Other', 'test-other-org', NOW());
INSERT INTO "user" (id, name, email, "createdAt", "updatedAt") VALUES
  ('test-learner', 'Learner', 'learner@example.com', NOW(), NOW()),
  ('test-outsider', 'Outsider', 'outsider@example.com', NOW(), NOW()),
  ('test-trainer', 'Trainer', 'trainer@example.com', NOW(), NOW());
INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
  VALUES ('test-member', 'test-org', 'test-trainer', 'owner', NOW());
INSERT INTO "Persona" (id, "orgId", slug, name, data, "updatedAt")
  VALUES ('test-persona', 'test-org', 'test-persona', 'Persona', '{}', NOW());
INSERT INTO "Agent" (id, "orgId", slug, name, "domainSlug", "personaId", data, "updatedAt") VALUES
  ('test-agent', 'test-org', 'test-agent', 'Agent', 'test-domain', 'test-persona', '{}', NOW()),
  ('test-other-agent', 'test-org', 'test-other-agent', 'Other agent', 'test-domain', 'test-persona', '{}', NOW());
INSERT INTO "Deployment" (id, "orgId", "agentId", "publicKey", "updatedAt")
  VALUES ('test-deployment', 'test-org', 'test-agent', 'test-public-key', NOW());
INSERT INTO "RolePlayAssignment" (id, "orgId", "deploymentId", "recipientEmail", "assignedByUserId", "shareCode", "expiresAt")
  VALUES ('test-assignment', 'test-org', 'test-deployment', 'LEARNER@example.com', 'test-trainer', 'test-share', NOW() + INTERVAL '1 day');

INSERT INTO "InterviewSession" (id, "orgId", "userId", "agentId", "deploymentId", "assignmentId", "shareCode", "personaSlug", "personaVersion", "agentSlug", "agentVersion", "domainSlug", "domainVersion")
  VALUES ('test-assigned', 'test-org', 'test-learner', 'test-agent', 'test-deployment', 'test-assignment', 'test-session-1', 'test-persona', 1, 'test-agent', 1, 'test-domain', 1);

DO $$
BEGIN
  BEGIN
    INSERT INTO "InterviewSession" (id, "orgId", "userId", "agentId", "deploymentId", "assignmentId", "shareCode", "personaSlug", "personaVersion", "agentSlug", "agentVersion", "domainSlug", "domainVersion")
      VALUES ('test-wrong-user', 'test-org', 'test-outsider', 'test-agent', 'test-deployment', 'test-assignment', 'test-session-2', 'test-persona', 1, 'test-agent', 1, 'test-domain', 1);
    RAISE EXCEPTION 'Wrong learner was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Session assignment must belong to the user and organization' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO "InterviewSession" (id, "orgId", "userId", "agentId", "deploymentId", "assignmentId", "shareCode", "personaSlug", "personaVersion", "agentSlug", "agentVersion", "domainSlug", "domainVersion")
      VALUES ('test-wrong-org', 'test-other-org', 'test-learner', 'test-agent', 'test-deployment', 'test-assignment', 'test-session-other-org', 'test-persona', 1, 'test-agent', 1, 'test-domain', 1);
    RAISE EXCEPTION 'Cross-org session was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Session agent must belong to the same organization' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO "InterviewSession" (id, "orgId", "userId", "agentId", "deploymentId", "assignmentId", "shareCode", "personaSlug", "personaVersion", "agentSlug", "agentVersion", "domainSlug", "domainVersion")
      VALUES ('test-wrong-agent', 'test-org', 'test-learner', 'test-other-agent', 'test-deployment', 'test-assignment', 'test-session-other-agent', 'test-persona', 1, 'test-other-agent', 1, 'test-domain', 1);
    RAISE EXCEPTION 'Cross-scenario assignment was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Session assignment must belong to the user and organization' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO "InterviewSession" (id, "orgId", "userId", "agentId", "shareCode", "personaSlug", "personaVersion", "agentSlug", "agentVersion", "domainSlug", "domainVersion")
      VALUES ('test-no-assignment', 'test-org', 'test-learner', 'test-agent', 'test-session-3', 'test-persona', 1, 'test-agent', 1, 'test-domain', 1);
    RAISE EXCEPTION 'Unassigned learner was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Session user must belong to the same organization' THEN RAISE; END IF;
  END;
END $$;

INSERT INTO "InterviewSession" (id, "orgId", "userId", "agentId", "shareCode", "personaSlug", "personaVersion", "agentSlug", "agentVersion", "domainSlug", "domainVersion")
  VALUES ('test-member-session', 'test-org', 'test-trainer', 'test-agent', 'test-session-4', 'test-persona', 1, 'test-agent', 1, 'test-domain', 1);
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM "InterviewSession" WHERE id IN ('test-assigned', 'test-member-session')) <> 2 THEN
    RAISE EXCEPTION 'Expected assigned and member sessions';
  END IF;
END $$;
ROLLBACK;

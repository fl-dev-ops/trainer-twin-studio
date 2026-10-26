-- Run only against a disposable database with all Prisma migrations applied.
-- Twin calibration rules (migration 20261027030000_twin_calibration).
BEGIN;
INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('tc-org', 'TC', 'tc-org', NOW());
INSERT INTO "user" (id, name, email, "createdAt", "updatedAt") VALUES ('tc-admin', 'Admin', 'tc-admin@example.com', NOW(), NOW());
INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES ('tc-m', 'tc-org', 'tc-admin', 'admin', NOW());
INSERT INTO "Persona" (id, "orgId", slug, name, data, "isOwn", "updatedAt") VALUES ('tc-own', 'tc-org', 'tc-own', 'Own', '{}', true, NOW());
INSERT INTO "Agent" (id, "orgId", slug, name, "domainSlug", "personaId", kind, data, "updatedAt") VALUES
  ('tc-twin', 'tc-org', 'tc-twin', 'Twin', 'd', 'tc-own', 'TWIN', '{}', NOW()),
  ('tc-rp', 'tc-org', 'tc-rp', 'Role play', 'd', 'tc-own', 'ROLEPLAY', '{}', NOW());
INSERT INTO "InterviewSession" (id, "orgId", "userId", "agentId", "shareCode", "personaSlug", "personaVersion", "agentSlug", "agentVersion", "domainSlug", "domainVersion") VALUES
  ('tc-s-twin', 'tc-org', 'tc-admin', 'tc-twin', 'tc-s1', 'p', 1, 'tc-twin', 1, 'd', 1),
  ('tc-s-rp', 'tc-org', 'tc-admin', 'tc-rp', 'tc-s2', 'p', 1, 'tc-rp', 1, 'd', 1);

INSERT INTO "TwinCalibration" (id, "sessionId", "createdByUserId") VALUES ('tc-c', 'tc-s-twin', 'tc-admin');
INSERT INTO "TwinCalibrationRating" (id, "calibrationId", "turnIndex", question, reply, rating, "updatedAt")
  VALUES ('tc-r1', 'tc-c', 1, 'What do I say?', 'Ask what they will do with the money.', 'like', NOW());

DO $$
BEGIN
  BEGIN
    INSERT INTO "TwinCalibration" (id, "sessionId", "createdByUserId") VALUES ('tc-x1', 'tc-s-rp', 'tc-admin');
    RAISE EXCEPTION 'Calibration on a role play was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'A calibration must be a twin session' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO "TwinCalibration" (id, "sessionId", "createdByUserId") VALUES ('tc-x2', 'tc-s-twin', 'tc-admin');
    RAISE EXCEPTION 'Second calibration on one session was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "TwinCalibrationRating" (id, "calibrationId", "turnIndex", reply, rating, "updatedAt") VALUES ('tc-x3', 'tc-c', 1, 'x', 'off', NOW());
    RAISE EXCEPTION 'Second rating on one turn was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "TwinCalibrationRating" (id, "calibrationId", "turnIndex", reply, rating, "updatedAt") VALUES ('tc-x4', 'tc-c', 3, 'x', 'meh', NOW());
    RAISE EXCEPTION 'Unknown rating was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "TwinCalibrationRating" (id, "calibrationId", "turnIndex", reply, rating, "updatedAt") VALUES ('tc-x5', 'tc-c', -1, 'x', 'like', NOW());
    RAISE EXCEPTION 'Negative turn index was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- deleting the session removes its calibration and ratings
  DELETE FROM "InterviewSession" WHERE id = 'tc-s-twin';
  IF EXISTS (SELECT 1 FROM "TwinCalibrationRating" WHERE id = 'tc-r1') THEN RAISE EXCEPTION 'Ratings outlived their session'; END IF;
END $$;
ROLLBACK;

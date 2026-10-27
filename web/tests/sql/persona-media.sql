-- Run only against a disposable database with all Prisma migrations applied.
-- Persona media rules (migration 20261028020000_persona_media).
BEGIN;
INSERT INTO "organization" (id, name, slug, "createdAt") VALUES
  ('pm-org', 'PM', 'pm-org', NOW()),
  ('pm-other', 'PM other', 'pm-other', NOW());
INSERT INTO "Persona" (id, "orgId", slug, name, data, "updatedAt") VALUES
  ('pm-a', 'pm-org', 'pm-a', 'A', '{}', NOW()),
  ('pm-b', 'pm-org', 'pm-b', 'B', '{}', NOW()),
  ('pm-global', NULL, 'pm-global', 'Global', '{}', NOW());
INSERT INTO "Voice" (id, "orgId", name, "s3AudioKey", "updatedAt") VALUES
  ('pm-voice', 'pm-org', 'Voice', 'k', NOW()),
  ('pm-voice-other', 'pm-other', 'Other voice', 'k', NOW()),
  ('pm-voice-global', NULL, 'Global voice', 'k', NOW());
INSERT INTO "Avatar" (id, "orgId", name, "updatedAt") VALUES
  ('pm-avatar', 'pm-org', 'Avatar', NOW()),
  ('pm-avatar-other', 'pm-other', 'Other avatar', NOW()),
  ('pm-avatar-global', NULL, 'Global avatar', NOW());

-- Same org (or both global) is fine.
UPDATE "Persona" SET "voiceId" = 'pm-voice', "avatarId" = 'pm-avatar', settings = '{"pace":"slow"}' WHERE id = 'pm-a';
UPDATE "Persona" SET "voiceId" = 'pm-voice-global', "avatarId" = 'pm-avatar-global' WHERE id = 'pm-global';

DO $$
BEGIN
  -- Each persona owns its voice and avatar: no sharing.
  BEGIN
    UPDATE "Persona" SET "voiceId" = 'pm-voice' WHERE id = 'pm-b';
    RAISE EXCEPTION 'A shared voice was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    UPDATE "Persona" SET "avatarId" = 'pm-avatar' WHERE id = 'pm-b';
    RAISE EXCEPTION 'A shared avatar was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- Another org's (or a global) voice / avatar cannot be attached.
  BEGIN
    UPDATE "Persona" SET "voiceId" = 'pm-voice-other' WHERE id = 'pm-b';
    RAISE EXCEPTION 'A cross-org voice was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Persona voice must belong to the same organization' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE "Persona" SET "avatarId" = 'pm-avatar-other' WHERE id = 'pm-b';
    RAISE EXCEPTION 'A cross-org avatar was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Persona avatar must belong to the same organization' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO "Voice" (id, "orgId", name, "s3AudioKey", "updatedAt") VALUES ('pm-voice-g2', NULL, 'G2', 'k', NOW());
    UPDATE "Persona" SET "voiceId" = 'pm-voice-g2' WHERE id = 'pm-b';
    RAISE EXCEPTION 'A global voice on an org persona was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Persona voice must belong to the same organization' THEN RAISE; END IF;
  END;
  -- Settings must be a JSON object.
  BEGIN
    UPDATE "Persona" SET settings = '"fast"' WHERE id = 'pm-b';
    RAISE EXCEPTION 'Non-object settings were accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- An owned voice / avatar cannot move to another org, and the persona cannot move away from them.
  BEGIN
    UPDATE "Voice" SET "orgId" = 'pm-other' WHERE id = 'pm-voice';
    RAISE EXCEPTION 'An owned voice moved org';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Voice organization cannot change while a persona owns it' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE "Avatar" SET "orgId" = 'pm-other' WHERE id = 'pm-avatar';
    RAISE EXCEPTION 'An owned avatar moved org';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Avatar organization cannot change while a persona owns it' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE "Persona" SET "orgId" = 'pm-other' WHERE id = 'pm-a';
    RAISE EXCEPTION 'A persona moved away from its voice';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Persona voice must belong to the same organization' THEN RAISE; END IF;
  END;
END $$;

-- Deleting a voice / avatar unlinks it; the persona stays.
DELETE FROM "Voice" WHERE id = 'pm-voice';
DELETE FROM "Avatar" WHERE id = 'pm-avatar';
DO $$
BEGIN
  IF (SELECT "voiceId" IS NOT NULL OR "avatarId" IS NOT NULL FROM "Persona" WHERE id = 'pm-a') THEN
    RAISE EXCEPTION 'Persona still points at a deleted voice or avatar';
  END IF;
END $$;
ROLLBACK;

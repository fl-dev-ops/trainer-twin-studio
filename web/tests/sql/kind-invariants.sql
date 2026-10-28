-- Run only against a disposable database with all Prisma migrations applied.
-- Twin / role play split rules (migration 20261027000000_split_twin_roleplay).
BEGIN;
INSERT INTO "organization" (id, name, slug, "createdAt") VALUES
  ('kind-org', 'Kind', 'kind-org', NOW()),
  ('kind-other-org', 'Other', 'kind-other-org', NOW());
INSERT INTO "Persona" (id, "orgId", slug, name, data, "isOwn", "updatedAt") VALUES
  ('kind-own', 'kind-org', 'kind-own', 'Own', '{}', true, NOW()),
  ('kind-character', 'kind-org', 'kind-character', 'Character', '{}', false, NOW()),
  ('kind-global', NULL, 'kind-global', 'Global', '{}', false, NOW()),
  ('kind-other-own', 'kind-other-org', 'kind-other-own', 'Other own', '{}', true, NOW());
INSERT INTO "Agent" (id, "orgId", slug, name, "personaId", kind, data, "updatedAt") VALUES
  ('kind-twin', 'kind-org', 'kind-twin', 'Twin', 'kind-own', 'TWIN', '{}', NOW()),
  -- an org role play may use a global persona
  ('kind-rp', 'kind-org', 'kind-rp', 'Role play', 'kind-global', 'ROLEPLAY', '{}', NOW());

DO $$
BEGIN
  BEGIN
    UPDATE "Agent" SET kind = 'ROLEPLAY' WHERE id = 'kind-twin';
    RAISE EXCEPTION 'Agent kind change was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Agent.kind cannot change' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE "Persona" SET "isOwn" = false WHERE id = 'kind-own';
    RAISE EXCEPTION 'Persona isOwn change was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Persona.isOwn cannot change' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO "Persona" (id, "orgId", slug, name, data, "isOwn", "updatedAt") VALUES ('kind-bad', NULL, 'kind-bad', 'x', '{}', true, NOW());
    RAISE EXCEPTION 'Global own persona was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%persona_global_not_own%' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO "Persona" (id, "orgId", slug, name, data, "updatedAt") VALUES ('kind-dup', NULL, 'kind-global', 'x', '{}', NOW());
    RAISE EXCEPTION 'Duplicate global persona slug was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "Agent" (id, "orgId", slug, name, "personaId", kind, data, "updatedAt")
      VALUES ('kind-x1', 'kind-org', 'kind-x1', 'x', 'kind-character', 'TWIN', '{}', NOW());
    RAISE EXCEPTION 'Twin on a character persona was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'twin kind-x1 must use the user''s own persona' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO "Agent" (id, "orgId", slug, name, "personaId", kind, data, "updatedAt")
      VALUES ('kind-x2', 'kind-org', 'kind-x2', 'x', 'kind-global', 'TWIN', '{}', NOW());
    RAISE EXCEPTION 'Twin on a global persona was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'twin kind-x2 must use the user''s own persona' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO "Agent" (id, "orgId", slug, name, "personaId", kind, data, "updatedAt")
      VALUES ('kind-x3', 'kind-org', 'kind-x3', 'x', 'kind-other-own', 'ROLEPLAY', '{}', NOW());
    RAISE EXCEPTION 'Another org persona was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Agent persona must belong to the same organization or be global' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;

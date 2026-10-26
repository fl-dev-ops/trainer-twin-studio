-- Run only against a disposable database with all Prisma migrations applied.
-- Org roles (migration 20261027010000_org_roles): admin | team | user, one per member.
BEGIN;
INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('roles-org', 'Roles', 'roles-org', NOW());
INSERT INTO "user" (id, name, email, "createdAt", "updatedAt") VALUES
  ('roles-a', 'A', 'roles-a@example.com', NOW(), NOW()),
  ('roles-d', 'D', 'roles-d@example.com', NOW(), NOW());
INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES ('roles-m', 'roles-org', 'roles-a', 'team', NOW());
-- no role given -> user
INSERT INTO "member" (id, "organizationId", "userId", "createdAt") VALUES ('roles-md', 'roles-org', 'roles-d', NOW());
DO $$
DECLARE bad text;
BEGIN
  IF (SELECT role FROM "member" WHERE id = 'roles-md') <> 'user' THEN RAISE EXCEPTION 'member role does not default to user'; END IF;
  FOREACH bad IN ARRAY ARRAY['owner', 'member', 'admin,team', 'Admin'] LOOP
    BEGIN
      UPDATE "member" SET role = bad WHERE id = 'roles-m';
      RAISE EXCEPTION 'member role % was accepted', bad;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  BEGIN
    INSERT INTO "invitation" (id, "organizationId", email, role, "expiresAt", "inviterId")
      VALUES ('roles-i', 'roles-org', 'x@example.com', 'member', NOW() + INTERVAL '1 day', 'roles-a');
    RAISE EXCEPTION 'invitation role member was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;

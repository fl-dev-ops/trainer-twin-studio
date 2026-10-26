-- Twin / Role play split (plans/twin-roleplay-db-split.md §8).
-- Agent.kind (TWIN | ROLEPLAY) and SpecDraft.kind are required and have no default; Persona.isOwn marks the
-- user's own persona. Triggers, CHECKs and NULLS NOT DISTINCT are not tracked by Prisma; they live only here.

-- 1. add columns
CREATE TYPE "agent_kind" AS ENUM ('TWIN', 'ROLEPLAY');
ALTER TABLE "Agent"     ADD COLUMN "kind" "agent_kind";
ALTER TABLE "SpecDraft" ADD COLUMN "kind" "agent_kind";
ALTER TABLE "Persona"   ADD COLUMN "isOwn" BOOLEAN;

-- 2. fill from today's data
UPDATE "Agent" SET "kind" = CASE
  WHEN data->>'source' IN ('twin', 'scenario-ingest') THEN 'TWIN'
  ELSE 'ROLEPLAY' END::"agent_kind";
UPDATE "SpecDraft" SET "kind" = 'ROLEPLAY'; -- ingest never drafts; drafts are copilot or builder
UPDATE "Persona" SET "isOwn" = ("orgId" IS NOT NULL AND coalesce(data->>'kind', '') <> 'client');

-- 3. lock down
ALTER TABLE "Agent"     ALTER COLUMN "kind"  SET NOT NULL;
ALTER TABLE "SpecDraft" ALTER COLUMN "kind"  SET NOT NULL;
ALTER TABLE "Persona"   ALTER COLUMN "isOwn" SET NOT NULL;
ALTER TABLE "Persona"   ALTER COLUMN "isOwn" SET DEFAULT false;
ALTER TABLE "Persona"   ADD CONSTRAINT persona_global_not_own CHECK (NOT ("isOwn" AND "orgId" IS NULL));
CREATE INDEX "Agent_orgId_kind_idx"     ON "Agent"("orgId", "kind");
CREATE INDEX "Agent_personaId_kind_idx" ON "Agent"("personaId", "kind");
CREATE INDEX "SpecDraft_orgId_kind_idx" ON "SpecDraft"("orgId", "kind");

-- Global rows (orgId NULL) must be unique too: same index names Prisma knows, NULLs now compare equal.
DROP INDEX "Persona_orgId_slug_key";
CREATE UNIQUE INDEX "Persona_orgId_slug_key" ON "Persona"("orgId", "slug") NULLS NOT DISTINCT;
DROP INDEX "SpecVersion_orgId_entityType_entitySlug_version_key";
CREATE UNIQUE INDEX "SpecVersion_orgId_entityType_entitySlug_version_key"
  ON "SpecVersion"("orgId", "entityType", "entitySlug", "version") NULLS NOT DISTINCT;

-- 4. rules the app can't break
CREATE FUNCTION tt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%.% cannot change', TG_TABLE_NAME, TG_ARGV[0];
END $$;
CREATE TRIGGER agent_kind_immutable BEFORE UPDATE OF "kind" ON "Agent"
  FOR EACH ROW WHEN (OLD."kind" IS DISTINCT FROM NEW."kind") EXECUTE FUNCTION tt_immutable('kind');
CREATE TRIGGER persona_isown_immutable BEFORE UPDATE OF "isOwn" ON "Persona"
  FOR EACH ROW WHEN (OLD."isOwn" IS DISTINCT FROM NEW."isOwn") EXECUTE FUNCTION tt_immutable('isOwn');

-- A twin is always the user's own persona, never a global or invented one.
CREATE FUNCTION tt_twin_needs_own() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" = 'TWIN' AND NOT (SELECT "isOwn" FROM "Persona" WHERE id = NEW."personaId") THEN
    RAISE EXCEPTION 'twin % must use the user''s own persona', NEW.slug;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_twin_needs_own BEFORE INSERT OR UPDATE OF "kind", "personaId" ON "Agent"
  FOR EACH ROW EXECUTE FUNCTION tt_twin_needs_own();

-- 5. let org agents use global personas (was: same org only, migration 20260908152000).
CREATE OR REPLACE FUNCTION enforce_agent_persona_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Persona"
    WHERE id = NEW."personaId" AND ("orgId" IS NOT DISTINCT FROM NEW."orgId" OR "orgId" IS NULL)
  ) THEN
    RAISE EXCEPTION 'Agent persona must belong to the same organization or be global';
  END IF;
  RETURN NEW;
END $$;

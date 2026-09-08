-- Scope persona URLs to their organization instead of globally.
DROP INDEX "Persona_slug_key";
CREATE UNIQUE INDEX "Persona_orgId_slug_key" ON "Persona"("orgId", "slug");

-- Version numbers for the same slug may now coexist across organizations.
DROP INDEX "SpecVersion_entityType_entitySlug_version_key";
CREATE UNIQUE INDEX "SpecVersion_orgId_entityType_entitySlug_version_key"
ON "SpecVersion"("orgId", "entityType", "entitySlug", "version");

-- Persona sources use the immutable persona ID. Existing S3 keys remain valid
-- because each row retains its exact object key.
ALTER TABLE "PersonaSource" ADD COLUMN "personaId" TEXT;
UPDATE "PersonaSource" AS source
SET "personaId" = persona."id",
    "status" = CASE WHEN source."status" = 'compiling' THEN 'analyzed' ELSE source."status" END,
    "metadata" = COALESCE(source."metadata", '{}'::jsonb) - 'voiceMoments'
FROM "Persona" AS persona
WHERE source."personaSlug" = persona."slug"
  AND source."orgId" IS NOT DISTINCT FROM persona."orgId";
ALTER TABLE "PersonaSource" ALTER COLUMN "personaId" SET NOT NULL;
ALTER TABLE "PersonaSource"
  ADD CONSTRAINT "PersonaSource_personaId_fkey"
  FOREIGN KEY ("personaId") REFERENCES "Persona"("id") ON DELETE CASCADE ON UPDATE CASCADE;
DROP INDEX "PersonaSource_personaSlug_idx";
ALTER TABLE "PersonaSource" DROP COLUMN "personaSlug";
CREATE INDEX "PersonaSource_personaId_idx" ON "PersonaSource"("personaId");

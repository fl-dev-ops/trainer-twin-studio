-- Older spec snapshots were written without orgId. Backfill them while their
-- original globally unique slugs still identify one owning organization.
UPDATE "SpecVersion" AS version
SET "orgId" = persona."orgId"
FROM "Persona" AS persona
WHERE version."orgId" IS NULL
  AND version."entityType" = 'personas'
  AND version."entitySlug" = persona."slug";

UPDATE "SpecVersion" AS version
SET "orgId" = agent."orgId"
FROM "Agent" AS agent
WHERE version."orgId" IS NULL
  AND version."entityType" = 'agents'
  AND version."entitySlug" = agent."slug";

UPDATE "SpecVersion" AS version
SET "orgId" = domain."orgId"
FROM "Domain" AS domain
WHERE version."orgId" IS NULL
  AND version."entityType" = 'domains'
  AND version."entitySlug" = domain."slug";

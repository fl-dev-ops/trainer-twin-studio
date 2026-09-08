-- Published agents own one persona. Prefer the published draft selection, then
-- the persona most often used with that agent in historical sessions.
ALTER TABLE "Agent" ADD COLUMN "personaId" TEXT;

UPDATE "Agent" AS agent
SET "personaId" = persona.id
FROM "SpecDraft" AS draft
JOIN "Persona" AS persona
  ON persona.slug = draft."personaSlug" AND persona."orgId" = draft."orgId"
WHERE draft.slug = agent.slug AND draft."orgId" = agent."orgId";

WITH ranked AS (
  SELECT session."orgId", session."agentSlug", session."personaSlug", COUNT(*) AS uses,
         ROW_NUMBER() OVER (
           PARTITION BY session."orgId", session."agentSlug"
           ORDER BY COUNT(*) DESC, session."personaSlug"
         ) AS rank
  FROM "InterviewSession" AS session
  GROUP BY session."orgId", session."agentSlug", session."personaSlug"
)
UPDATE "Agent" AS agent
SET "personaId" = persona.id
FROM ranked
JOIN "Persona" AS persona
  ON persona.slug = ranked."personaSlug" AND persona."orgId" = ranked."orgId"
WHERE agent."personaId" IS NULL
  AND ranked.rank = 1
  AND agent.slug = ranked."agentSlug"
  AND agent."orgId" = ranked."orgId";

-- Unused legacy agents can only be inferred safely when the org has one persona.
WITH sole_persona AS (
  SELECT "orgId", MIN(id) AS id
  FROM "Persona"
  GROUP BY "orgId"
  HAVING COUNT(*) = 1
)
UPDATE "Agent" AS agent
SET "personaId" = sole_persona.id
FROM sole_persona
WHERE agent."personaId" IS NULL AND agent."orgId" = sole_persona."orgId";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Agent" WHERE "personaId" IS NULL) THEN
    RAISE EXCEPTION 'Every Agent needs a persona before this migration can continue';
  END IF;
END $$;

ALTER TABLE "Agent" ALTER COLUMN "personaId" SET NOT NULL;
CREATE INDEX "Agent_personaId_idx" ON "Agent"("personaId");
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_personaId_fkey"
  FOREIGN KEY ("personaId") REFERENCES "Persona"(id) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Bind every historical and future session to immutable tenant/user/agent IDs.
ALTER TABLE "InterviewSession"
  ADD COLUMN "agentId" TEXT,
  ADD COLUMN "shareCode" TEXT,
  ADD COLUMN "runtimeTokenHash" TEXT,
  ADD COLUMN "contextId" TEXT,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "InterviewSession" AS session
SET "agentId" = agent.id
FROM "Agent" AS agent
WHERE agent.slug = session."agentSlug" AND agent."orgId" = session."orgId";

-- Sessions created before authenticated launch were Studio runs. Preserve them
-- under the org owner rather than discarding their recordings/transcripts.
UPDATE "InterviewSession" AS session
SET "userId" = (
  SELECT member."userId"
  FROM "member" AS member
  WHERE member."organizationId" = session."orgId"
  ORDER BY CASE WHEN member.role IN ('owner', 'admin') THEN 0 ELSE 1 END, member."createdAt"
  LIMIT 1
)
WHERE session."userId" IS NULL;

UPDATE "InterviewSession"
SET "shareCode" = SUBSTRING(MD5(id || RANDOM()::text) FROM 1 FOR 12),
    "createdAt" = "startedAt";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "InterviewSession"
    WHERE "orgId" IS NULL OR "userId" IS NULL OR "agentId" IS NULL OR "shareCode" IS NULL
  ) THEN
    RAISE EXCEPTION 'Could not bind every historical InterviewSession to org/user/agent';
  END IF;
END $$;

ALTER TABLE "InterviewSession" ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "InterviewSession" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "InterviewSession" ALTER COLUMN "agentId" SET NOT NULL;
ALTER TABLE "InterviewSession" ALTER COLUMN "shareCode" SET NOT NULL;
ALTER TABLE "InterviewSession" ALTER COLUMN "startedAt" DROP NOT NULL;
ALTER TABLE "InterviewSession" ALTER COLUMN "startedAt" DROP DEFAULT;
ALTER TABLE "InterviewSession" ALTER COLUMN status SET DEFAULT 'assigned';

CREATE UNIQUE INDEX "InterviewSession_shareCode_key" ON "InterviewSession"("shareCode");
CREATE INDEX "InterviewSession_orgId_userId_idx" ON "InterviewSession"("orgId", "userId");
CREATE INDEX "InterviewSession_agentId_idx" ON "InterviewSession"("agentId");
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_status_check"
  CHECK (status IN ('assigned', 'active', 'completed', 'abandoned', 'revoked'));
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "organization"(id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_contextId_fkey"
  FOREIGN KEY ("contextId") REFERENCES "ContextDocument"(id) ON DELETE SET NULL ON UPDATE CASCADE;
DROP INDEX "InterviewSession_orgId_idx";

-- One current launch URL per assignment. Historical sessions stay independent.
ALTER TABLE "RolePlayAssignment" ADD COLUMN "sessionId" TEXT;

INSERT INTO "InterviewSession" (
  id, "orgId", "userId", "agentId", "shareCode", "personaSlug", "personaVersion",
  "agentSlug", "agentVersion", "domainSlug", "domainVersion", status, "createdAt", "startedAt"
)
SELECT
  'assignment_' || assignment.id,
  assignment."orgId",
  member."userId",
  agent.id,
  SUBSTRING(MD5('assignment:' || assignment.id || RANDOM()::text) FROM 1 FOR 12),
  persona.slug,
  persona.version,
  agent.slug,
  agent.version,
  domain.slug,
  domain.version,
  'assigned',
  assignment."assignedAt",
  NULL
FROM "RolePlayAssignment" AS assignment
JOIN "member" AS member ON member.id = assignment."memberId"
JOIN "Agent" AS agent ON agent.id = assignment."agentId"
JOIN "Persona" AS persona ON persona.id = agent."personaId"
JOIN "Domain" AS domain ON domain.slug = agent."domainSlug" AND domain."orgId" = assignment."orgId";

UPDATE "RolePlayAssignment"
SET "sessionId" = 'assignment_' || id;

CREATE UNIQUE INDEX "RolePlayAssignment_sessionId_key" ON "RolePlayAssignment"("sessionId");
ALTER TABLE "RolePlayAssignment" ADD CONSTRAINT "RolePlayAssignment_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "InterviewSession"(id) ON DELETE SET NULL ON UPDATE CASCADE;

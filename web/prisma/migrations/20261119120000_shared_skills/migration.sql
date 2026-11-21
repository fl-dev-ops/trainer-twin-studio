CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ownerSlug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nextVersion" INTEGER NOT NULL DEFAULT 1,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "currentVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Skill_nextVersion_check" CHECK ("nextVersion" > 0),
    CONSTRAINT "Skill_generation_check" CHECK ("generation" >= 0)
);

CREATE TABLE "SkillVersion" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "format" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "indexStatus" TEXT NOT NULL DEFAULT 'pending',
    "publicationGeneration" INTEGER NOT NULL DEFAULT 0,
    "contentHash" TEXT NOT NULL,
    "skillText" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "files" JSONB NOT NULL,
    "artifacts" TEXT NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "failure" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SkillVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SkillVersion_version_check" CHECK ("version" > 0),
    CONSTRAINT "SkillVersion_itemCount_check" CHECK ("itemCount" >= 0),
    CONSTRAINT "SkillVersion_publicationGeneration_check" CHECK ("publicationGeneration" >= 0),
    CONSTRAINT "SkillVersion_format_check" CHECK ("format" IN ('twin', 'legacy-twin', 'builder-roleplay', 'authored-roleplay')),
    CONSTRAINT "SkillVersion_status_check" CHECK ("status" IN ('pending', 'ready', 'failed')),
    CONSTRAINT "SkillVersion_indexStatus_check" CHECK ("indexStatus" IN ('pending', 'ready', 'failed')),
    CONSTRAINT "SkillVersion_failure_check" CHECK (char_length("failure") <= 2000),
    CONSTRAINT "SkillVersion_files_check" CHECK (jsonb_typeof("files") = 'object'),
    CONSTRAINT "SkillVersion_manifest_check" CHECK (jsonb_typeof("manifest") = 'object')
);

ALTER TABLE "Agent" ADD COLUMN "primarySkillId" TEXT;
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_primarySkill_org_check"
    CHECK ("primarySkillId" IS NULL OR "orgId" IS NOT NULL);

CREATE UNIQUE INDEX "Skill_orgId_ownerSlug_key" ON "Skill"("orgId", "ownerSlug");
CREATE UNIQUE INDEX "Skill_id_orgId_key" ON "Skill"("id", "orgId");
CREATE INDEX "Skill_currentVersionId_id_idx" ON "Skill"("currentVersionId", "id");
CREATE UNIQUE INDEX "SkillVersion_skillId_version_key" ON "SkillVersion"("skillId", "version");
CREATE UNIQUE INDEX "SkillVersion_id_skillId_key" ON "SkillVersion"("id", "skillId");
CREATE INDEX "Agent_primarySkillId_orgId_idx" ON "Agent"("primarySkillId", "orgId");

ALTER TABLE "Skill" ADD CONSTRAINT "Skill_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "SkillVersion" ADD CONSTRAINT "SkillVersion_skillId_fkey"
    FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_currentVersionId_id_fkey"
    FOREIGN KEY ("currentVersionId", "id") REFERENCES "SkillVersion"("id", "skillId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_primarySkillId_orgId_fkey"
    FOREIGN KEY ("primarySkillId", "orgId") REFERENCES "Skill"("id", "orgId") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION enforce_skill_current_ready() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- Read the final row, not a stale NEW image from an earlier update in this transaction.
    IF EXISTS (
        SELECT 1 FROM "Skill" s
        JOIN "SkillVersion" v ON v."id" = s."currentVersionId" AND v."skillId" = s."id"
        WHERE s."id" = NEW."id" AND v."status" <> 'ready'
    ) THEN
        RAISE EXCEPTION 'Skill currentVersion must be ready'
            USING ERRCODE = '23514', CONSTRAINT = 'Skill_currentVersion_ready';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Skill_currentVersion_ready"
AFTER INSERT OR UPDATE ON "Skill"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_skill_current_ready();

CREATE FUNCTION protect_ready_skill_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD."status" = 'ready' THEN
        IF (to_jsonb(NEW) - ARRAY['indexStatus', 'failure', 'updatedAt', 'publicationGeneration'])
            IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['indexStatus', 'failure', 'updatedAt', 'publicationGeneration']) THEN
            RAISE EXCEPTION 'Ready SkillVersion package and status are immutable'
                USING ERRCODE = '23514', CONSTRAINT = 'SkillVersion_ready_immutable';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "SkillVersion_ready_immutable"
BEFORE UPDATE ON "SkillVersion"
FOR EACH ROW EXECUTE FUNCTION protect_ready_skill_version();

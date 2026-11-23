CREATE TABLE "AgentSkillVersion" (
    "agentId" TEXT NOT NULL,
    "agentVersion" INTEGER NOT NULL,
    "orgId" TEXT NOT NULL,
    "skillVersionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentSkillVersion_pkey" PRIMARY KEY ("agentId", "agentVersion"),
    CONSTRAINT "AgentSkillVersion_agentVersion_check" CHECK ("agentVersion" > 0)
);

CREATE INDEX "AgentSkillVersion_skillVersionId_idx" ON "AgentSkillVersion"("skillVersionId");
CREATE INDEX "AgentSkillVersion_orgId_idx" ON "AgentSkillVersion"("orgId");
ALTER TABLE "AgentSkillVersion" ADD CONSTRAINT "AgentSkillVersion_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "AgentSkillVersion" ADD CONSTRAINT "AgentSkillVersion_skillVersionId_fkey"
    FOREIGN KEY ("skillVersionId") REFERENCES "SkillVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "SkillVersionSource" (
    "skillVersionId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "items" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SkillVersionSource_pkey" PRIMARY KEY ("skillVersionId", "documentId"),
    CONSTRAINT "SkillVersionSource_items_check" CHECK ("items" >= 0)
);

CREATE INDEX "SkillVersionSource_orgId_documentId_idx" ON "SkillVersionSource"("orgId", "documentId");
ALTER TABLE "SkillVersionSource" ADD CONSTRAINT "SkillVersionSource_skillVersionId_fkey"
    FOREIGN KEY ("skillVersionId") REFERENCES "SkillVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION validate_agent_skill_version_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    version_row "SkillVersion"%ROWTYPE;
    skill_row "Skill"%ROWTYPE;
    agent_row "Agent"%ROWTYPE;
BEGIN
    SELECT * INTO version_row FROM "SkillVersion" WHERE "id" = NEW."skillVersionId" FOR SHARE;
    SELECT * INTO skill_row FROM "Skill" WHERE "id" = version_row."skillId" FOR SHARE;
    SELECT * INTO agent_row FROM "Agent" WHERE "id" = NEW."agentId" FOR SHARE;
    IF agent_row."orgId" IS DISTINCT FROM NEW."orgId"
        OR skill_row."orgId" IS DISTINCT FROM NEW."orgId"
        OR skill_row."ownerSlug" IS DISTINCT FROM agent_row."slug"
        OR version_row."status" IS DISTINCT FROM 'ready'
        OR version_row."indexStatus" IS DISTINCT FROM 'ready' THEN
        RAISE EXCEPTION 'Agent history mapping requires its ready same-org owner package'
            USING ERRCODE = '23514', CONSTRAINT = 'AgentSkillVersion_package_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "AgentSkillVersion_package_check"
BEFORE INSERT ON "AgentSkillVersion"
FOR EACH ROW EXECUTE FUNCTION validate_agent_skill_version_insert();

CREATE FUNCTION protect_agent_skill_version_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Agent skill history mappings are immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'AgentSkillVersion_immutable';
END;
$$;

CREATE TRIGGER "AgentSkillVersion_immutable"
BEFORE UPDATE ON "AgentSkillVersion"
FOR EACH ROW EXECUTE FUNCTION protect_agent_skill_version_update();

CREATE FUNCTION validate_skill_version_source() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    version_row "SkillVersion"%ROWTYPE;
    skill_org TEXT;
BEGIN
    SELECT * INTO version_row FROM "SkillVersion" WHERE "id" = NEW."skillVersionId" FOR SHARE;
    SELECT "orgId" INTO skill_org FROM "Skill" WHERE "id" = version_row."skillId" FOR SHARE;
    IF skill_org IS DISTINCT FROM NEW."orgId" THEN
        RAISE EXCEPTION 'Skill source must belong to its package organization'
            USING ERRCODE = '23514', CONSTRAINT = 'SkillVersionSource_org_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "SkillVersionSource_org_check"
BEFORE INSERT OR UPDATE ON "SkillVersionSource"
FOR EACH ROW EXECUTE FUNCTION validate_skill_version_source();

CREATE FUNCTION protect_mapped_agent_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW."orgId" IS DISTINCT FROM OLD."orgId" OR NEW."slug" IS DISTINCT FROM OLD."slug")
        AND EXISTS (SELECT 1 FROM "AgentSkillVersion" WHERE "agentId" = OLD."id") THEN
        RAISE EXCEPTION 'Mapped agent organization and owner alias are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'Agent_skillHistory_identity_immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "Agent_skillHistory_identity_immutable"
BEFORE UPDATE OF "orgId", "slug" ON "Agent"
FOR EACH ROW EXECUTE FUNCTION protect_mapped_agent_identity();

CREATE FUNCTION protect_skill_history_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW."orgId" IS DISTINCT FROM OLD."orgId" OR NEW."ownerSlug" IS DISTINCT FROM OLD."ownerSlug")
        AND EXISTS (
            SELECT 1 FROM "SkillVersion" v
            WHERE v."skillId" = OLD."id" AND (
                EXISTS (SELECT 1 FROM "AgentSkillVersion" m WHERE m."skillVersionId" = v."id")
                OR EXISTS (SELECT 1 FROM "SkillVersionSource" s WHERE s."skillVersionId" = v."id")
            )
        ) THEN
        RAISE EXCEPTION 'Skill history organization and owner alias are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'Skill_history_identity_immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "Skill_history_identity_immutable"
BEFORE UPDATE OF "orgId", "ownerSlug" ON "Skill"
FOR EACH ROW EXECUTE FUNCTION protect_skill_history_identity();

CREATE FUNCTION protect_sourced_version_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."skillId" IS DISTINCT FROM OLD."skillId"
        AND EXISTS (SELECT 1 FROM "SkillVersionSource" WHERE "skillVersionId" = OLD."id") THEN
        RAISE EXCEPTION 'Sourced package skill identity is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'SkillVersion_source_identity_immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "SkillVersion_source_identity_immutable"
BEFORE UPDATE OF "skillId" ON "SkillVersion"
FOR EACH ROW EXECUTE FUNCTION protect_sourced_version_identity();

ALTER TABLE "SkillVersion" ADD COLUMN "indexGeneration" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SkillVersion" ADD CONSTRAINT "SkillVersion_indexGeneration_check"
    CHECK ("indexGeneration" >= 0);

CREATE OR REPLACE FUNCTION protect_ready_skill_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD."status" = 'ready' THEN
        IF (to_jsonb(NEW) - ARRAY['indexStatus', 'indexGeneration', 'failure', 'updatedAt', 'publicationGeneration'])
            IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['indexStatus', 'indexGeneration', 'failure', 'updatedAt', 'publicationGeneration']) THEN
            RAISE EXCEPTION 'Ready SkillVersion package and status are immutable'
                USING ERRCODE = '23514', CONSTRAINT = 'SkillVersion_ready_immutable';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

ALTER TABLE "InterviewSession" ADD COLUMN "skillPinsVersion" INTEGER;
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_skillPinsVersion_check"
    CHECK ("skillPinsVersion" IS NULL OR "skillPinsVersion" = 1);
CREATE UNIQUE INDEX "InterviewSession_id_orgId_key" ON "InterviewSession"("id", "orgId");

CREATE TABLE "SessionSkill" (
    "sessionId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "skillVersionId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionSkill_pkey" PRIMARY KEY ("sessionId", "alias"),
    CONSTRAINT "SessionSkill_position_check" CHECK ("position" >= 0)
);

CREATE UNIQUE INDEX "SessionSkill_sessionId_position_key" ON "SessionSkill"("sessionId", "position");
CREATE INDEX "SessionSkill_skillVersionId_idx" ON "SessionSkill"("skillVersionId");
ALTER TABLE "SessionSkill" ADD CONSTRAINT "SessionSkill_sessionId_orgId_fkey"
    FOREIGN KEY ("sessionId", "orgId") REFERENCES "InterviewSession"("id", "orgId")
    ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "SessionSkill" ADD CONSTRAINT "SessionSkill_skillVersionId_fkey"
    FOREIGN KEY ("skillVersionId") REFERENCES "SkillVersion"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION validate_session_skill_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    session_row "InterviewSession"%ROWTYPE;
    version_row "SkillVersion"%ROWTYPE;
    skill_row "Skill"%ROWTYPE;
    agent_kind "agent_kind";
BEGIN
    SELECT * INTO session_row FROM "InterviewSession" WHERE "id" = NEW."sessionId" FOR SHARE;
    SELECT * INTO version_row FROM "SkillVersion" WHERE "id" = NEW."skillVersionId" FOR SHARE;
    SELECT * INTO skill_row FROM "Skill" WHERE "id" = version_row."skillId" FOR SHARE;
    SELECT "kind" INTO agent_kind FROM "Agent" WHERE "id" = session_row."agentId" FOR KEY SHARE;

    IF session_row."skillPinsVersion" IS DISTINCT FROM 1
        OR session_row."orgId" IS DISTINCT FROM NEW."orgId"
        OR skill_row."orgId" IS DISTINCT FROM NEW."orgId"
        OR version_row."status" IS DISTINCT FROM 'ready'
        OR version_row."indexStatus" IS DISTINCT FROM 'ready'
        OR NEW."alias" IS DISTINCT FROM skill_row."ownerSlug" THEN
        RAISE EXCEPTION 'Session pin requires a ready same-org package and its owner alias'
            USING ERRCODE = '23514', CONSTRAINT = 'SessionSkill_package_check';
    END IF;
    IF agent_kind = 'ROLEPLAY' AND (
        version_row."format" NOT IN ('builder-roleplay', 'authored-roleplay')
        OR NEW."alias" IS DISTINCT FROM session_row."agentSlug"
        OR NEW."position" <> 0
    ) THEN
        RAISE EXCEPTION 'Role-play pin must be the session owner role-play package at position zero'
            USING ERRCODE = '23514', CONSTRAINT = 'SessionSkill_roleplay_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "SessionSkill_package_check"
BEFORE INSERT ON "SessionSkill"
FOR EACH ROW EXECUTE FUNCTION validate_session_skill_insert();

CREATE FUNCTION protect_session_skill_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Session skill pins are immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'SessionSkill_immutable';
END;
$$;

CREATE TRIGGER "SessionSkill_immutable"
BEFORE UPDATE ON "SessionSkill"
FOR EACH ROW EXECUTE FUNCTION protect_session_skill_update();

CREATE FUNCTION protect_session_skill_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."skillPinsVersion" IS DISTINCT FROM OLD."skillPinsVersion"
        OR (OLD."skillPinsVersion" = 1 AND (
            NEW."id" IS DISTINCT FROM OLD."id"
            OR NEW."orgId" IS DISTINCT FROM OLD."orgId"
            OR NEW."agentId" IS DISTINCT FROM OLD."agentId"
            OR NEW."agentSlug" IS DISTINCT FROM OLD."agentSlug"
            OR NEW."agentVersion" IS DISTINCT FROM OLD."agentVersion"
            OR NEW."personaSlug" IS DISTINCT FROM OLD."personaSlug"
            OR NEW."personaVersion" IS DISTINCT FROM OLD."personaVersion"
            OR (NEW."compiledSnapshot" -> 'agent') IS DISTINCT FROM (OLD."compiledSnapshot" -> 'agent')
            OR (NEW."compiledSnapshot" -> 'persona') IS DISTINCT FROM (OLD."compiledSnapshot" -> 'persona')
        )) THEN
        RAISE EXCEPTION 'Session pin marker and managed identity are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'InterviewSession_skillPins_immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "InterviewSession_skillPins_immutable"
BEFORE UPDATE ON "InterviewSession"
FOR EACH ROW EXECUTE FUNCTION protect_session_skill_identity();

CREATE FUNCTION check_session_skill_completeness() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    session_id TEXT;
    marker INTEGER;
    agent_kind "agent_kind";
    pin_count BIGINT;
BEGIN
    IF TG_TABLE_NAME = 'InterviewSession' THEN
        session_id := NEW."id";
    ELSIF TG_OP = 'DELETE' THEN
        session_id := OLD."sessionId";
    ELSE
        session_id := NEW."sessionId";
    END IF;

    -- Re-read committed-shape rows; cascade deletion intentionally leaves no parent.
    SELECT s."skillPinsVersion", a."kind" INTO marker, agent_kind
    FROM "InterviewSession" s JOIN "Agent" a ON a."id" = s."agentId"
    WHERE s."id" = session_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    SELECT count(*) INTO pin_count FROM "SessionSkill" WHERE "sessionId" = session_id;
    IF (marker IS NULL AND pin_count <> 0)
        OR (marker = 1 AND agent_kind = 'ROLEPLAY' AND pin_count <> 1)
        OR (TG_OP = 'DELETE' AND marker = 1) THEN
        RAISE EXCEPTION 'Managed role-play requires one permanent pin; legacy sessions require none'
            USING ERRCODE = '23514', CONSTRAINT = 'InterviewSession_skillPins_complete';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "InterviewSession_skillPins_complete"
AFTER INSERT OR UPDATE ON "InterviewSession"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_session_skill_completeness();

CREATE CONSTRAINT TRIGGER "SessionSkill_session_complete"
AFTER INSERT OR DELETE ON "SessionSkill"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_session_skill_completeness();

CREATE FUNCTION protect_pinned_skill_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW."orgId" IS DISTINCT FROM OLD."orgId" OR NEW."ownerSlug" IS DISTINCT FROM OLD."ownerSlug")
        AND EXISTS (
            SELECT 1 FROM "SkillVersion" v JOIN "SessionSkill" p ON p."skillVersionId" = v."id"
            WHERE v."skillId" = OLD."id"
        ) THEN
        RAISE EXCEPTION 'Pinned skill organization and owner alias are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'Skill_pinned_identity_immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "Skill_pinned_identity_immutable"
BEFORE UPDATE OF "orgId", "ownerSlug" ON "Skill"
FOR EACH ROW EXECUTE FUNCTION protect_pinned_skill_identity();

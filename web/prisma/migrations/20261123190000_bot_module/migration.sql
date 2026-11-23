-- Bots become their own module (specs/bots.md), like twins and role plays: any persona, their own SKILL.md (a `bot`
-- skill package owned by the bot, versioned like a role play's) and chosen twin skills (AgentSkill). No twin link.

-- 1. The bot's own package format.
ALTER TABLE "SkillVersion" DROP CONSTRAINT "SkillVersion_format_check";
ALTER TABLE "SkillVersion" ADD CONSTRAINT "SkillVersion_format_check"
  CHECK ("format" IN ('twin', 'legacy-twin', 'builder-roleplay', 'authored-roleplay', 'bot'));

-- 2. Chosen skills: same-org twin skills, on bots only.
CREATE TABLE "AgentSkill" (
  "agentId" TEXT NOT NULL,
  "skillId" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentSkill_pkey" PRIMARY KEY ("agentId", "skillId"),
  CONSTRAINT "AgentSkill_position_check" CHECK ("position" >= 1)
);
CREATE UNIQUE INDEX "AgentSkill_agentId_position_key" ON "AgentSkill"("agentId", "position");
CREATE INDEX "AgentSkill_skillId_idx" ON "AgentSkill"("skillId");
CREATE INDEX "AgentSkill_orgId_idx" ON "AgentSkill"("orgId");
ALTER TABLE "AgentSkill" ADD CONSTRAINT "AgentSkill_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "AgentSkill" ADD CONSTRAINT "AgentSkill_skillId_fkey"
  FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION tt_agent_skill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Agent" WHERE id = NEW."agentId" AND "orgId" = NEW."orgId" AND kind = 'BOT') THEN
    RAISE EXCEPTION 'Chosen skills belong to a bot of the same organization';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "Skill" s JOIN "Agent" owner ON owner.slug = s."ownerSlug" AND owner."orgId" = s."orgId"
    WHERE s.id = NEW."skillId" AND s."orgId" = NEW."orgId" AND owner.kind = 'TWIN'
  ) THEN
    RAISE EXCEPTION 'A bot can only choose twin skills of its own organization';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_skill_check BEFORE INSERT OR UPDATE ON "AgentSkill"
  FOR EACH ROW EXECUTE FUNCTION tt_agent_skill();

-- 3. Personas: only twins must use the trainer's own; a bot may use any persona (like a role play).
CREATE OR REPLACE FUNCTION tt_twin_needs_own() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" = 'TWIN' AND NOT (SELECT "isOwn" FROM "Persona" WHERE id = NEW."personaId") THEN
    RAISE EXCEPTION 'twin % must use the user''s own persona', NEW.slug;
  END IF;
  RETURN NEW;
END $$;

-- 4. Session pins. A bot session pins its own `bot` package at position 0, then its chosen twin skills.
CREATE OR REPLACE FUNCTION validate_session_skill_insert() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF agent_kind = 'BOT' AND (
        (NEW."position" = 0 AND (version_row."format" <> 'bot' OR NEW."alias" IS DISTINCT FROM session_row."agentSlug"))
        OR (NEW."position" > 0 AND version_row."format" NOT IN ('twin', 'legacy-twin'))
    ) THEN
        RAISE EXCEPTION 'Bot pins are its own package at position zero, then twin skills'
            USING ERRCODE = '23514', CONSTRAINT = 'SessionSkill_bot_check';
    END IF;
    RETURN NEW;
END;
$$;

-- The twin catalog rules are the twin's alone again; a bot needs its own package at position 0.
CREATE OR REPLACE FUNCTION check_twin_skill_catalog() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    session_id TEXT;
    session_row "InterviewSession"%ROWTYPE;
    agent_row "Agent"%ROWTYPE;
    catalog JSONB;
    entry JSONB;
    catalog_position BIGINT;
    expected_count INTEGER := 0;
    actual_count INTEGER;
BEGIN
    IF TG_TABLE_NAME = 'InterviewSession' THEN
        session_id := NEW."id";
    ELSIF TG_OP = 'DELETE' THEN
        session_id := OLD."sessionId";
    ELSE
        session_id := NEW."sessionId";
    END IF;
    SELECT * INTO session_row FROM "InterviewSession" WHERE "id" = session_id;
    IF NOT FOUND OR session_row."skillPinsVersion" IS DISTINCT FROM 1 THEN RETURN NULL; END IF;
    SELECT * INTO agent_row FROM "Agent" WHERE "id" = session_row."agentId";
    IF agent_row."kind" = 'BOT' THEN
        IF NOT EXISTS (
            SELECT 1 FROM "SessionSkill" WHERE "sessionId" = session_id AND "alias" = session_row."agentSlug" AND "position" = 0
        ) THEN
            RAISE EXCEPTION 'A bot session requires its own package'
                USING ERRCODE = '23514', CONSTRAINT = 'SessionSkill_bot_check';
        END IF;
        RETURN NULL;
    END IF;
    IF agent_row."kind" <> 'TWIN' THEN RETURN NULL; END IF;

    IF TG_TABLE_NAME = 'SessionSkill' AND TG_OP = 'INSERT' AND EXISTS (
        SELECT 1 FROM "SessionSkill" p
        JOIN "SkillVersion" v ON v."id" = p."skillVersionId"
        JOIN "Skill" s ON s."id" = v."skillId"
        LEFT JOIN "Agent" owner ON owner."slug" = s."ownerSlug" AND owner."orgId" = s."orgId"
        WHERE p."sessionId" = session_id AND (
            v."format" NOT IN ('twin', 'legacy-twin')
            OR owner."kind" IS DISTINCT FROM 'TWIN'
            OR owner."personaId" IS DISTINCT FROM session_row."compiledSnapshot" #>> '{persona,id}'
        )
    ) THEN
        RAISE EXCEPTION 'Twin pins require twin packages from the same persona'
            USING ERRCODE = '23514', CONSTRAINT = 'SessionSkill_twin_persona_check';
    END IF;

    SELECT count(*) INTO actual_count FROM "SessionSkill" WHERE "sessionId" = session_id;
    IF session_row."compiledSnapshot" #>> '{agent,data,source}' = 'twin' THEN
        catalog := session_row."compiledSnapshot" -> 'twinSkills';
        IF catalog IS NULL OR jsonb_typeof(catalog) <> 'array' THEN
            RAISE EXCEPTION 'Managed main twin requires an explicit catalog'
                USING ERRCODE = '23514', CONSTRAINT = 'SessionSkill_twin_catalog_check';
        END IF;
        FOR entry, catalog_position IN SELECT value, ordinality - 1 FROM jsonb_array_elements(catalog) WITH ORDINALITY LOOP
            IF jsonb_typeof(entry) <> 'object' OR jsonb_typeof(entry -> 'slug') IS DISTINCT FROM 'string'
                OR jsonb_typeof(entry -> 'version') IS DISTINCT FROM 'number' THEN
                RAISE EXCEPTION 'Invalid twin catalog entry'
                    USING ERRCODE = '23514', CONSTRAINT = 'SessionSkill_twin_catalog_check';
            END IF;
            IF entry ? 'skillVersionId' THEN
                expected_count := expected_count + 1;
                IF NOT EXISTS (
                    SELECT 1 FROM "SessionSkill" p WHERE p."sessionId" = session_id
                    AND p."alias" = entry ->> 'slug' AND p."skillVersionId" = entry ->> 'skillVersionId'
                    AND p."position" = catalog_position
                ) THEN
                    RAISE EXCEPTION 'Twin catalog must match its immutable package pins'
                        USING ERRCODE = '23514', CONSTRAINT = 'SessionSkill_twin_catalog_check';
                END IF;
            END IF;
        END LOOP;
        IF actual_count <> expected_count OR
            (SELECT count(DISTINCT value ->> 'slug') FROM jsonb_array_elements(catalog)) <> jsonb_array_length(catalog) THEN
            RAISE EXCEPTION 'Twin catalog and pins must be unique and complete'
                USING ERRCODE = '23514', CONSTRAINT = 'SessionSkill_twin_catalog_check';
        END IF;
    ELSIF actual_count <> 1 OR NOT EXISTS (
        SELECT 1 FROM "SessionSkill" WHERE "sessionId" = session_id
        AND "alias" = session_row."agentSlug" AND "position" = 0
    ) THEN
        RAISE EXCEPTION 'Managed single twin requires its owner package'
            USING ERRCODE = '23514', CONSTRAINT = 'SessionSkill_twin_catalog_check';
    END IF;
    RETURN NULL;
END;
$$;

-- 5. Start fresh: bots made from twins (data.twinId) are retired. Their calls stay, on the archived bot.
UPDATE "Deployment" SET "status" = 'disabled', "updatedAt" = now()
  WHERE "agentId" IN (SELECT id FROM "Agent" WHERE kind = 'BOT' AND data ? 'twinId');
UPDATE "Agent" SET "archivedAt" = COALESCE("archivedAt", now()), "updatedAt" = now()
  WHERE kind = 'BOT' AND data ? 'twinId';

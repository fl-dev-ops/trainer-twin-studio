-- One pinning shape (specs/agents.md): a twin and a bot pin a catalog of skill versions (compiledSnapshot.twinSkills)
-- that must match their SessionSkill rows. A twin's comes from its supporting skills (or, until it is merged, every
-- skill twin of its persona); a bot's from its own `bot` package and its supporting skills, from any persona.

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
        (version_row."format" = 'bot' AND (NEW."position" <> 0 OR NEW."alias" IS DISTINCT FROM session_row."agentSlug"))
        OR version_row."format" NOT IN ('bot', 'twin', 'legacy-twin')
    ) THEN
        RAISE EXCEPTION 'Bot pins are its own package (first) and twin skills'
            USING ERRCODE = '23514', CONSTRAINT = 'SessionSkill_bot_check';
    END IF;
    RETURN NEW;
END;
$$;

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
    IF agent_row."kind" NOT IN ('TWIN', 'BOT') THEN RETURN NULL; END IF;

    IF TG_TABLE_NAME = 'SessionSkill' AND TG_OP = 'INSERT' AND EXISTS (
        SELECT 1 FROM "SessionSkill" p
        JOIN "SkillVersion" v ON v."id" = p."skillVersionId"
        JOIN "Skill" s ON s."id" = v."skillId"
        LEFT JOIN "Agent" owner ON owner."slug" = s."ownerSlug" AND owner."orgId" = s."orgId"
        WHERE p."sessionId" = session_id AND (
            -- A bot may carry its own `bot` package; every other pin is a twin skill. Twins draw on their own persona's
            -- skills; a bot speaks as any persona, so its skills may come from another.
            (v."format" NOT IN ('twin', 'legacy-twin') AND NOT (agent_row."kind" = 'BOT' AND v."format" = 'bot'))
            OR (v."format" <> 'bot' AND owner."kind" IS DISTINCT FROM 'TWIN')
            OR (agent_row."kind" = 'TWIN' AND owner."personaId" IS DISTINCT FROM session_row."compiledSnapshot" #>> '{persona,id}')
        )
    ) THEN
        RAISE EXCEPTION 'Twin pins require twin packages from the same persona'
            USING ERRCODE = '23514', CONSTRAINT = 'SessionSkill_twin_persona_check';
    END IF;

    SELECT count(*) INTO actual_count FROM "SessionSkill" WHERE "sessionId" = session_id;
    IF agent_row."kind" = 'BOT' OR session_row."compiledSnapshot" #>> '{agent,data,source}' = 'twin' THEN
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

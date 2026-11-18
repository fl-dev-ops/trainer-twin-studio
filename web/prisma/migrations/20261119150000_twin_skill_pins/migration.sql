CREATE FUNCTION protect_twin_skill_catalog() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD."skillPinsVersion" = 1 AND
        (NEW."compiledSnapshot" -> 'twinSkills') IS DISTINCT FROM (OLD."compiledSnapshot" -> 'twinSkills') THEN
        RAISE EXCEPTION 'Managed twin skill catalogs are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'InterviewSession_twinSkills_immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "InterviewSession_twinSkills_immutable"
BEFORE UPDATE ON "InterviewSession"
FOR EACH ROW EXECUTE FUNCTION protect_twin_skill_catalog();

CREATE FUNCTION check_twin_skill_catalog() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE CONSTRAINT TRIGGER "InterviewSession_twin_catalog_check"
AFTER INSERT OR UPDATE ON "InterviewSession"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_twin_skill_catalog();

CREATE CONSTRAINT TRIGGER "SessionSkill_twin_catalog_check"
AFTER INSERT OR DELETE ON "SessionSkill"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_twin_skill_catalog();

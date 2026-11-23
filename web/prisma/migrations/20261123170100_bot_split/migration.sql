-- Split public calls and the website widget off twins into bots (specs/public-twins.md).
--
-- Before: a twin's data held publicAccess {enabled, maxSeconds} and widget {enabled, allowedOrigins, welcome,
-- accentColor}; anonymous sessions ran on the twin. After: each such twin gets a BOT agent on the same persona
-- (data.twinId links back; objective and config copied) with one public Deployment holding those settings.
-- Anonymous sessions move to the bot; the twin keeps everything else and drops the two keys.

-- 1. Triggers: anonymous, public and widget rules move from TWIN to BOT.

-- Bots, like twins, speak as the trainer: their own persona only.
CREATE OR REPLACE FUNCTION tt_twin_needs_own() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" IN ('TWIN', 'BOT') AND NOT (SELECT "isOwn" FROM "Persona" WHERE id = NEW."personaId") THEN
    RAISE EXCEPTION '% % must use the user''s own persona', lower(NEW."kind"::text), NEW.slug;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION enforce_interview_session_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Agent" WHERE id = NEW."agentId" AND "orgId" = NEW."orgId") THEN
    RAISE EXCEPTION 'Session agent must belong to the same organization';
  END IF;
  IF NEW."anonymousId" IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM "Agent" WHERE id = NEW."agentId" AND kind = 'BOT') THEN
      RAISE EXCEPTION 'Anonymous sessions are only for bots';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."assignmentId" IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM "RolePlayAssignment" a
      JOIN "Deployment" d ON d.id = a."deploymentId"
      JOIN "member" m ON m.id = a."memberId"
      WHERE a.id = NEW."assignmentId" AND a."orgId" = NEW."orgId"
        AND d."orgId" = NEW."orgId" AND d."agentId" = NEW."agentId"
        AND (NEW."deploymentId" IS NULL OR NEW."deploymentId" = a."deploymentId")
        AND m."userId" = NEW."userId" AND m."organizationId" = NEW."orgId"
    ) THEN
      RAISE EXCEPTION 'Session assignment must belong to the user and organization';
    END IF;
  ELSIF NEW."twinAssignmentId" IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM "TwinAssignment" t
      WHERE t.id = NEW."twinAssignmentId" AND t."orgId" = NEW."orgId"
        AND t."agentId" = NEW."agentId" AND t."userId" = NEW."userId"
    ) THEN
      RAISE EXCEPTION 'Session twin assignment must belong to the user and organization';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM "member" WHERE "userId" = NEW."userId" AND "organizationId" = NEW."orgId"
  ) THEN
    RAISE EXCEPTION 'Session user must belong to the same organization';
  END IF;
  IF NEW."contextId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ContextDocument" WHERE id = NEW."contextId" AND "orgId" = NEW."orgId"
  ) THEN
    RAISE EXCEPTION 'Session context must belong to the same organization';
  END IF;
  RETURN NEW;
END $$;

-- Twin sessions: voice, assigned (or studio). Bot sessions: voice, anonymous, within the bot's public deployment.
CREATE OR REPLACE FUNCTION tt_twin_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  agent_kind "agent_kind";
BEGIN
  SELECT kind INTO agent_kind FROM "Agent" WHERE id = NEW."agentId";
  IF agent_kind = 'TWIN' THEN
    IF NEW."mode" <> 'voice' THEN
      RAISE EXCEPTION 'Twin sessions are voice only';
    END IF;
    IF NEW."twinAssignmentId" IS NULL AND NOT EXISTS (
      SELECT 1 FROM "member" WHERE "userId" = NEW."userId" AND "organizationId" = NEW."orgId"
        AND "role" IN ('admin', 'team')
    ) THEN
      RAISE EXCEPTION 'Twin sessions need a twin assignment unless the user is admin or team';
    END IF;
  ELSIF agent_kind = 'BOT' THEN
    IF NEW."mode" <> 'voice' THEN
      RAISE EXCEPTION 'Bot sessions are voice only';
    END IF;
    IF NEW."anonymousId" IS NULL THEN
      RAISE EXCEPTION 'Bot sessions are for anonymous visitors';
    END IF;
    IF TG_OP = 'INSERT' AND NOT EXISTS (
      SELECT 1 FROM "Agent" a JOIN "Deployment" d ON d."agentId" = a.id AND d."orgId" = a."orgId"
      WHERE a.id = NEW."agentId" AND a."archivedAt" IS NULL
        AND d."channel" = 'public' AND d."status" = 'active'
        AND d."maxCallSeconds" >= NEW."allowedSeconds"
    ) THEN
      RAISE EXCEPTION 'Public access is not enabled for this bot';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Widget sessions: an allowed website of an active bot. Checked when the origin is set, not on later moves.
CREATE OR REPLACE FUNCTION tt_widget_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."embedOrigin" IS NOT DISTINCT FROM OLD."embedOrigin" THEN
    RETURN NEW;
  END IF;
  IF NEW."embedOrigin" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Agent" a JOIN "Deployment" d ON d."agentId" = a.id AND d."orgId" = a."orgId"
    WHERE a.id = NEW."agentId" AND a."orgId" = NEW."orgId" AND a.kind = 'BOT' AND a."archivedAt" IS NULL
      AND d."channel" = 'public' AND d."status" = 'active'
      AND COALESCE(d."allowedOrigins", '[]'::jsonb) ? NEW."embedOrigin"
  ) THEN
    RAISE EXCEPTION 'Widget sessions require an active bot and an allowed website';
  END IF;
  RETURN NEW;
END $$;

-- Skill pins: a bot pins its trainer's twin skills exactly like the main twin it came from.
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
            v."format" NOT IN ('twin', 'legacy-twin')
            OR owner."kind" IS DISTINCT FROM 'TWIN'
            OR owner."personaId" IS DISTINCT FROM session_row."compiledSnapshot" #>> '{persona,id}'
        )
    ) THEN
        RAISE EXCEPTION 'Twin pins require twin packages from the same persona'
            USING ERRCODE = '23514', CONSTRAINT = 'SessionSkill_twin_persona_check';
    END IF;

    SELECT count(*) INTO actual_count FROM "SessionSkill" WHERE "sessionId" = session_id;
    IF session_row."compiledSnapshot" #>> '{agent,data,source}' IN ('twin', 'bot') THEN
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

-- 2. Data: one bot and one public deployment per twin that had public or widget settings.
DO $$
DECLARE
  twin RECORD;
  bot_id TEXT;
  bot_slug TEXT;
  suffix INTEGER;
  public_on BOOLEAN;
  seconds INTEGER;
  origins JSONB;
BEGIN
  FOR twin IN
    SELECT * FROM "Agent" WHERE kind = 'TWIN' AND (data ? 'publicAccess' OR data ? 'widget') ORDER BY "createdAt"
  LOOP
    bot_id := 'bot' || substr(md5(twin.id), 1, 22);
    bot_slug := twin.slug || '-bot';
    suffix := 2;
    WHILE EXISTS (SELECT 1 FROM "Agent" WHERE slug = bot_slug) LOOP
      bot_slug := twin.slug || '-bot-' || suffix;
      suffix := suffix + 1;
    END LOOP;
    public_on := COALESCE((twin.data #>> '{publicAccess,enabled}')::boolean, false);
    seconds := CASE WHEN (twin.data #>> '{publicAccess,maxSeconds}') IN ('300', '600', '900', '1200', '1800')
      THEN (twin.data #>> '{publicAccess,maxSeconds}')::int ELSE 300 END;
    origins := CASE WHEN jsonb_typeof(twin.data #> '{widget,allowedOrigins}') = 'array'
      THEN twin.data #> '{widget,allowedOrigins}' ELSE '[]'::jsonb END;

    INSERT INTO "Agent" ("id", "orgId", "visibility", "slug", "name", "version", "personaId", "kind", "data", "order",
      "archivedAt", "createdAt", "updatedAt")
    VALUES (bot_id, twin."orgId", twin."visibility", bot_slug, twin."name", 1, twin."personaId", 'BOT',
      jsonb_strip_nulls(jsonb_build_object(
        'id', bot_slug,
        'name', twin."name",
        'source', 'bot',
        'twinId', twin.id,
        'objective', twin.data -> 'objective',
        'config', twin.data -> 'config'
      )),
      0, twin."archivedAt", now(), now());

    INSERT INTO "Deployment" ("id", "orgId", "agentId", "publicKey", "allowedModes", "allowedOrigins", "status",
      "rateLimitPerMinute", "channel", "maxCallSeconds", "config", "createdAt", "updatedAt")
    VALUES ('dep' || substr(md5(twin.id || ':public'), 1, 22), twin."orgId", bot_id,
      'pub_' || md5(twin.id || ':' || clock_timestamp()::text || random()::text), 'voice', origins,
      CASE WHEN public_on THEN 'active' ELSE 'disabled' END, 30, 'public', seconds,
      jsonb_build_object(
        'welcome', COALESCE(twin.data #>> '{widget,welcome}', 'Talk to my AI twin'),
        'accentColor', COALESCE(twin.data #>> '{widget,accentColor}', '#111111')
      ),
      now(), now());

    -- Anonymous calls happened on the public channel, so they are the bot's. Learner sessions stay on the twin.
    UPDATE "InterviewSession" SET "agentId" = bot_id
      WHERE "agentId" = twin.id AND "anonymousId" IS NOT NULL;

    UPDATE "Agent" SET "data" = "data" - 'publicAccess' - 'widget' WHERE id = twin.id;
  END LOOP;
END $$;

-- History identity survives index outages; runtime session pins enforce index readiness separately.
CREATE OR REPLACE FUNCTION validate_agent_skill_version_insert() RETURNS trigger
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
        OR version_row."status" IS DISTINCT FROM 'ready' THEN
        RAISE EXCEPTION 'Agent history mapping requires its ready same-org owner package'
            USING ERRCODE = '23514', CONSTRAINT = 'AgentSkillVersion_package_check';
    END IF;
    RETURN NEW;
END;
$$;

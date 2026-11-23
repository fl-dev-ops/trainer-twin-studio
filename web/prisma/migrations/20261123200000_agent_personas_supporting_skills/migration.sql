-- Twin, role play and bot share one shape (specs/agents.md): one main skill (Agent.primarySkillId), ordered supporting
-- skills that can be switched off (AgentSkill.active), and their persona(s) (AgentPersona). Persona and Skill are
-- libraries the agents connect to. This migration adds the links and backfills personas; runtime moves over later.

-- 1. Supporting skills: any agent kind, any same-org twin (knowledge) skill, switchable.
ALTER TABLE "AgentSkill" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION tt_agent_skill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Agent" WHERE id = NEW."agentId" AND "orgId" = NEW."orgId") THEN
    RAISE EXCEPTION 'Supporting skills belong to an agent of the same organization';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "Skill" s JOIN "SkillVersion" v ON v.id = s."currentVersionId"
    WHERE s.id = NEW."skillId" AND s."orgId" = NEW."orgId" AND v."format" IN ('twin', 'legacy-twin')
  ) THEN
    RAISE EXCEPTION 'A supporting skill is a published twin skill of the same organization';
  END IF;
  IF EXISTS (SELECT 1 FROM "Agent" WHERE id = NEW."agentId" AND "primarySkillId" = NEW."skillId") THEN
    RAISE EXCEPTION 'An agent''s main skill cannot also support it';
  END IF;
  RETURN NEW;
END $$;

-- 2. Personas per agent.
CREATE TABLE "AgentPersona" (
  "agentId" TEXT NOT NULL,
  "personaId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentPersona_pkey" PRIMARY KEY ("agentId", "personaId"),
  CONSTRAINT "AgentPersona_position_check" CHECK ("position" >= 0)
);
CREATE UNIQUE INDEX "AgentPersona_agentId_position_key" ON "AgentPersona"("agentId", "position");
CREATE INDEX "AgentPersona_personaId_idx" ON "AgentPersona"("personaId");
ALTER TABLE "AgentPersona" ADD CONSTRAINT "AgentPersona_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "AgentPersona" ADD CONSTRAINT "AgentPersona_personaId_fkey"
  FOREIGN KEY ("personaId") REFERENCES "Persona"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Backfill before the rules: every agent speaks as its current persona.
INSERT INTO "AgentPersona" ("agentId", "personaId", "position", "active")
SELECT id, "personaId", 0, true FROM "Agent";

-- Same-org (or global) personas only.
CREATE FUNCTION tt_agent_persona_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Agent" a JOIN "Persona" p ON p.id = NEW."personaId"
    WHERE a.id = NEW."agentId" AND (p."orgId" IS NULL OR p."orgId" = a."orgId")
  ) THEN
    RAISE EXCEPTION 'An agent''s persona must belong to its organization or be global';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_persona_org BEFORE INSERT OR UPDATE ON "AgentPersona"
  FOR EACH ROW EXECUTE FUNCTION tt_agent_persona_org();

-- Per kind, checked at commit for live agents: a twin has exactly one active persona, the user's own; a bot exactly
-- one active persona; a role play at least one. Agent.personaId must be one of them (it mirrors the first).
CREATE FUNCTION check_agent_personas() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  agent_id TEXT;
  agent_row "Agent"%ROWTYPE;
  active_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'Agent' THEN
    agent_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    agent_id := OLD."agentId";
  ELSE
    agent_id := NEW."agentId";
  END IF;
  SELECT * INTO agent_row FROM "Agent" WHERE id = agent_id;
  IF NOT FOUND OR agent_row."archivedAt" IS NOT NULL THEN RETURN NULL; END IF;
  SELECT count(*) INTO active_count FROM "AgentPersona" WHERE "agentId" = agent_id AND active;
  IF agent_row.kind IN ('TWIN', 'BOT') AND active_count <> 1 THEN
    RAISE EXCEPTION '% % must speak as exactly one persona', lower(agent_row.kind::text), agent_row.slug
      USING ERRCODE = '23514', CONSTRAINT = 'AgentPersona_kind_check';
  END IF;
  IF agent_row.kind = 'ROLEPLAY' AND active_count < 1 THEN
    RAISE EXCEPTION 'role play % needs at least one persona', agent_row.slug
      USING ERRCODE = '23514', CONSTRAINT = 'AgentPersona_kind_check';
  END IF;
  IF agent_row.kind = 'TWIN' AND EXISTS (
    SELECT 1 FROM "AgentPersona" ap JOIN "Persona" p ON p.id = ap."personaId"
    WHERE ap."agentId" = agent_id AND ap.active AND NOT p."isOwn"
  ) THEN
    RAISE EXCEPTION 'twin % must use the user''s own persona', agent_row.slug
      USING ERRCODE = '23514', CONSTRAINT = 'AgentPersona_kind_check';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "AgentPersona" WHERE "agentId" = agent_id AND "personaId" = agent_row."personaId") THEN
    RAISE EXCEPTION 'agent % default persona must be one of its personas', agent_row.slug
      USING ERRCODE = '23514', CONSTRAINT = 'AgentPersona_kind_check';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "AgentPersona_kind_check" AFTER INSERT OR UPDATE OR DELETE ON "AgentPersona"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_agent_personas();
CREATE CONSTRAINT TRIGGER "Agent_personas_check" AFTER INSERT OR UPDATE OF "personaId", kind, "archivedAt" ON "Agent"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_agent_personas();

-- Until every writer manages AgentPersona itself, an agent's persona column keeps its persona row in step: a new
-- agent gets its row; changing the persona of a one-persona agent moves that row (a role play's pool keeps the others).
CREATE FUNCTION tt_agent_persona_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "AgentPersona" ("agentId", "personaId", "position", "active")
    VALUES (NEW.id, NEW."personaId", 0, true) ON CONFLICT DO NOTHING;
  ELSIF NEW."personaId" IS DISTINCT FROM OLD."personaId"
    AND NOT EXISTS (SELECT 1 FROM "AgentPersona" WHERE "agentId" = NEW.id AND "personaId" = NEW."personaId") THEN
    IF (SELECT count(*) FROM "AgentPersona" WHERE "agentId" = NEW.id) <= 1 THEN
      DELETE FROM "AgentPersona" WHERE "agentId" = NEW.id;
      INSERT INTO "AgentPersona" ("agentId", "personaId", "position", "active") VALUES (NEW.id, NEW."personaId", 0, true);
    ELSE
      INSERT INTO "AgentPersona" ("agentId", "personaId", "position", "active")
      VALUES (NEW.id, NEW."personaId", (SELECT max("position") + 1 FROM "AgentPersona" WHERE "agentId" = NEW.id), true);
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER agent_persona_sync AFTER INSERT OR UPDATE OF "personaId" ON "Agent"
  FOR EACH ROW EXECUTE FUNCTION tt_agent_persona_sync();

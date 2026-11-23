-- Role play persona pools (specs/agents.md): changing an agent's main persona (Agent.personaId, set by every brief,
-- builder and publish save) swaps it in where the old main persona was, at the head of the pool; extra personas stay.
CREATE OR REPLACE FUNCTION tt_agent_persona_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "AgentPersona" ("agentId", "personaId", "position", "active")
    VALUES (NEW.id, NEW."personaId", 0, true) ON CONFLICT DO NOTHING;
  ELSIF NEW."personaId" IS DISTINCT FROM OLD."personaId" THEN
    -- The new main may already be an extra: it moves to the old main's place rather than appearing twice.
    DELETE FROM "AgentPersona" WHERE "agentId" = NEW.id AND "personaId" = NEW."personaId";
    UPDATE "AgentPersona" SET "personaId" = NEW."personaId", "active" = true
      WHERE "agentId" = NEW.id AND "personaId" = OLD."personaId";
    IF NOT FOUND THEN
      INSERT INTO "AgentPersona" ("agentId", "personaId", "position", "active")
      VALUES (NEW.id, NEW."personaId", COALESCE((SELECT max("position") + 1 FROM "AgentPersona" WHERE "agentId" = NEW.id), 0), true);
    END IF;
  END IF;
  RETURN NULL;
END $$;

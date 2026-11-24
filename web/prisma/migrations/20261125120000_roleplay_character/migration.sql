-- Role play characters: each (role play, persona) pair has its own SKILL.md, independent of every other role play.
ALTER TABLE "AgentPersona" ADD COLUMN "character" TEXT;

-- Swapping a role play's main persona must not hand the old persona's character to the new one.
CREATE OR REPLACE FUNCTION tt_agent_persona_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "AgentPersona" ("agentId", "personaId", "position", "active")
    VALUES (NEW.id, NEW."personaId", 0, true) ON CONFLICT DO NOTHING;
  ELSIF NEW."personaId" IS DISTINCT FROM OLD."personaId" THEN
    -- The new main may already be an extra (with its own character): it moves to the old main's place.
    IF EXISTS (SELECT 1 FROM "AgentPersona" WHERE "agentId" = NEW.id AND "personaId" = NEW."personaId") THEN
      UPDATE "AgentPersona" SET "character" = (SELECT "character" FROM "AgentPersona" WHERE "agentId" = NEW.id AND "personaId" = NEW."personaId")
        WHERE "agentId" = NEW.id AND "personaId" = OLD."personaId";
    ELSE
      UPDATE "AgentPersona" SET "character" = NULL WHERE "agentId" = NEW.id AND "personaId" = OLD."personaId";
    END IF;
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

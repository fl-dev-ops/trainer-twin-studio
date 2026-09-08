-- Foreign keys prove each row exists; these triggers prove all referenced rows
-- belong to the same tenant as the session/assignment.
CREATE OR REPLACE FUNCTION enforce_agent_persona_org() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Persona"
    WHERE id = NEW."personaId" AND "orgId" = NEW."orgId"
  ) THEN
    RAISE EXCEPTION 'Agent persona must belong to the same organization';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Agent_persona_org_check"
BEFORE INSERT OR UPDATE OF "orgId", "personaId" ON "Agent"
FOR EACH ROW EXECUTE FUNCTION enforce_agent_persona_org();

CREATE OR REPLACE FUNCTION enforce_interview_session_org() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Agent" WHERE id = NEW."agentId" AND "orgId" = NEW."orgId") THEN
    RAISE EXCEPTION 'Session agent must belong to the same organization';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "member"
    WHERE "userId" = NEW."userId" AND "organizationId" = NEW."orgId"
  ) THEN
    RAISE EXCEPTION 'Session user must belong to the same organization';
  END IF;
  IF NEW."contextId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ContextDocument"
    WHERE id = NEW."contextId" AND "orgId" = NEW."orgId"
  ) THEN
    RAISE EXCEPTION 'Session context must belong to the same organization';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "InterviewSession_org_check"
BEFORE INSERT OR UPDATE OF "orgId", "userId", "agentId", "contextId" ON "InterviewSession"
FOR EACH ROW EXECUTE FUNCTION enforce_interview_session_org();

CREATE OR REPLACE FUNCTION enforce_assignment_org() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Agent" WHERE id = NEW."agentId" AND "orgId" = NEW."orgId") THEN
    RAISE EXCEPTION 'Assignment agent must belong to the same organization';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "member" WHERE id = NEW."memberId" AND "organizationId" = NEW."orgId") THEN
    RAISE EXCEPTION 'Assignment member must belong to the same organization';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RolePlayAssignment_org_check"
BEFORE INSERT OR UPDATE OF "orgId", "memberId", "agentId" ON "RolePlayAssignment"
FOR EACH ROW EXECUTE FUNCTION enforce_assignment_org();

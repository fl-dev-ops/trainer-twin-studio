BEGIN;

DROP INDEX "Persona_voiceId_key";
CREATE INDEX "Persona_voiceId_idx" ON "Persona"("voiceId");
ALTER TABLE "Persona" DROP CONSTRAINT "Persona_voiceId_fkey";
ALTER TABLE "Persona" ADD CONSTRAINT "Persona_voiceId_fkey"
  FOREIGN KEY ("voiceId") REFERENCES "Voice"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "InterviewSession" ADD COLUMN "resolvedVoiceId" TEXT;
CREATE INDEX "InterviewSession_resolvedVoiceId_idx" ON "InterviewSession"("resolvedVoiceId");
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_resolvedVoiceId_fkey"
  FOREIGN KEY ("resolvedVoiceId") REFERENCES "Voice"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION voice_reference_ids(document JSONB) RETURNS SETOF TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT DISTINCT value #>> '{}'
  FROM (VALUES
    (document -> 'voiceId'),
    (document -> 'voice'),
    (document #> '{voice,id}'),
    (document #> '{data,voiceId}'),
    (document #> '{agent,voiceId}'),
    (document #> '{agent,data,voiceId}'),
    (document #> '{persona,voiceId}'),
    (document #> '{persona,data,voiceId}')
  ) AS candidates(value)
  WHERE jsonb_typeof(value) = 'string' AND btrim(value #>> '{}') <> ''
$$;

CREATE FUNCTION voice_is_referenced(voice_id TEXT) RETURNS BOOLEAN
LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "Persona"
    WHERE "voiceId" = voice_id OR voice_id IN (SELECT voice_reference_ids(data))
  ) OR EXISTS (
    SELECT 1 FROM "Agent" WHERE voice_id IN (SELECT voice_reference_ids(data))
  ) OR EXISTS (
    SELECT 1 FROM "SpecVersion" WHERE voice_id IN (SELECT voice_reference_ids(data))
  ) OR EXISTS (
    SELECT 1 FROM "InterviewSession"
    WHERE "resolvedVoiceId" = voice_id OR voice_id IN (SELECT voice_reference_ids("compiledSnapshot"))
  )
$$;

CREATE OR REPLACE FUNCTION enforce_persona_media_org() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  selected_voice "Voice"%ROWTYPE;
BEGIN
  -- Unchanged legacy attachments remain intact, including incomplete recordings.
  IF NEW."voiceId" IS NOT NULL AND (
    TG_OP = 'INSERT' OR NEW."voiceId" IS DISTINCT FROM OLD."voiceId" OR NEW."orgId" IS DISTINCT FROM OLD."orgId"
  ) THEN
    SELECT * INTO selected_voice FROM "Voice" WHERE id = NEW."voiceId" FOR SHARE;
    IF NOT FOUND OR selected_voice.status <> 'ready' OR btrim(selected_voice."s3AudioKey") = ''
      OR NOT (
        selected_voice."orgId" IS NOT DISTINCT FROM NEW."orgId"
        OR (selected_voice."orgId" IS NULL AND selected_voice.kind = 'sample')
      ) THEN
      RAISE EXCEPTION 'Persona voice must be an available organization voice or global sample';
    END IF;
  END IF;
  IF NEW."avatarId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Avatar" WHERE id = NEW."avatarId" AND "orgId" IS NOT DISTINCT FROM NEW."orgId"
  ) THEN
    RAISE EXCEPTION 'Persona avatar must belong to the same organization';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION enforce_voice_json_references() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  document JSONB;
  previous JSONB;
  voice_id TEXT;
  selected_voice "Voice"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'InterviewSession' THEN
    document := NEW."compiledSnapshot";
    IF TG_OP = 'UPDATE' THEN previous := OLD."compiledSnapshot"; END IF;
  ELSE
    document := NEW.data;
    IF TG_OP = 'UPDATE' THEN previous := OLD.data; END IF;
  END IF;
  FOR voice_id IN SELECT voice_reference_ids(document) ORDER BY 1 LOOP
    IF TG_OP = 'UPDATE' AND NEW."orgId" IS NOT DISTINCT FROM OLD."orgId"
      AND voice_id IN (SELECT voice_reference_ids(previous)) THEN
      CONTINUE;
    END IF;
    SELECT * INTO selected_voice FROM "Voice" WHERE id = voice_id FOR SHARE;
    -- Historical data preserves missing/incomplete references without granting live use.
    IF TG_TABLE_NAME = 'SpecVersion' THEN
      IF FOUND AND selected_voice.status = 'deleting' THEN
        RAISE EXCEPTION 'A deleting voice cannot acquire historical references';
      END IF;
      CONTINUE;
    END IF;
    IF NOT FOUND OR selected_voice.status <> 'ready' OR btrim(selected_voice."s3AudioKey") = ''
      OR NOT (
        selected_voice."orgId" IS NOT DISTINCT FROM NEW."orgId"
        OR (selected_voice."orgId" IS NULL AND selected_voice.kind = 'sample')
      ) THEN
      RAISE EXCEPTION 'Voice reference must be an available organization voice or global sample';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE TRIGGER tt_persona_voice_json
  BEFORE INSERT OR UPDATE OF data, "orgId" ON "Persona"
  FOR EACH ROW EXECUTE FUNCTION enforce_voice_json_references();
CREATE TRIGGER tt_agent_voice_json
  BEFORE INSERT OR UPDATE OF data, "orgId" ON "Agent"
  FOR EACH ROW EXECUTE FUNCTION enforce_voice_json_references();
CREATE TRIGGER tt_spec_version_voice_json
  BEFORE INSERT OR UPDATE OF data, "orgId" ON "SpecVersion"
  FOR EACH ROW EXECUTE FUNCTION enforce_voice_json_references();
CREATE TRIGGER tt_session_voice_json
  BEFORE INSERT OR UPDATE OF "compiledSnapshot", "orgId" ON "InterviewSession"
  FOR EACH ROW EXECUTE FUNCTION enforce_voice_json_references();

CREATE FUNCTION enforce_session_resolved_voice() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  selected_voice "Voice"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."resolvedVoiceId" IS NOT NULL
    AND NEW."resolvedVoiceId" IS DISTINCT FROM OLD."resolvedVoiceId" THEN
    RAISE EXCEPTION 'A session voice cannot change once resolved';
  END IF;
  IF NEW."resolvedVoiceId" IS NOT NULL AND (
    TG_OP = 'INSERT' OR NEW."resolvedVoiceId" IS DISTINCT FROM OLD."resolvedVoiceId" OR NEW."orgId" IS DISTINCT FROM OLD."orgId"
  ) THEN
    SELECT * INTO selected_voice FROM "Voice" WHERE id = NEW."resolvedVoiceId" FOR SHARE;
    IF NOT FOUND OR selected_voice.status <> 'ready' OR btrim(selected_voice."s3AudioKey") = ''
      OR NOT (
        selected_voice."orgId" IS NOT DISTINCT FROM NEW."orgId"
        OR (selected_voice."orgId" IS NULL AND selected_voice.kind = 'sample')
      ) THEN
      RAISE EXCEPTION 'Session voice must be an available organization voice or global sample';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tt_session_resolved_voice
  BEFORE INSERT OR UPDATE OF "resolvedVoiceId", "orgId" ON "InterviewSession"
  FOR EACH ROW EXECUTE FUNCTION enforce_session_resolved_voice();

DROP TRIGGER tt_voice_owner_org ON "Voice";
CREATE FUNCTION enforce_shared_voice_references() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF voice_is_referenced(OLD.id) THEN
      RAISE EXCEPTION 'Voice is in use' USING ERRCODE = '23503';
    END IF;
    RETURN OLD;
  END IF;
  IF (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW."orgId" IS DISTINCT FROM OLD."orgId"
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW."s3AudioKey" IS DISTINCT FROM OLD."s3AudioKey"
    OR NEW."s3TranscriptKey" IS DISTINCT FROM OLD."s3TranscriptKey"
  ) THEN
    IF OLD.status = 'deleting' THEN
      RAISE EXCEPTION 'A deleting voice cannot change its identity, organization or reference files' USING ERRCODE = '23514';
    END IF;
    IF voice_is_referenced(OLD.id) THEN
      RAISE EXCEPTION 'Voice reference and organization cannot change while in use' USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tt_shared_voice_references
  BEFORE DELETE OR UPDATE OF id, "orgId", kind, status, "s3AudioKey", "s3TranscriptKey" ON "Voice"
  FOR EACH ROW EXECUTE FUNCTION enforce_shared_voice_references();

COMMIT;

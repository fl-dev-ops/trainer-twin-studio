BEGIN;

CREATE OR REPLACE FUNCTION enforce_voice_json_references() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  document JSONB;
  previous JSONB;
  voice_id TEXT;
  selected_voice "Voice"%ROWTYPE;
  historical_reference BOOLEAN := TG_TABLE_NAME = 'SpecVersion';
BEGIN
  IF TG_TABLE_NAME = 'InterviewSession' THEN
    document := NEW."compiledSnapshot";
    historical_reference := NEW.mode = 'chat';
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
    IF historical_reference THEN
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

COMMIT;

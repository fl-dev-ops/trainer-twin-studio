ALTER TABLE "InterviewSession" ADD COLUMN "embedOrigin" TEXT;
ALTER TABLE "InterviewSession" ADD CONSTRAINT session_embed_owner_check
  CHECK ("embedOrigin" IS NULL OR ("anonymousId" IS NOT NULL AND "userId" IS NULL));

CREATE FUNCTION tt_widget_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."embedOrigin" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Agent" WHERE id = NEW."agentId" AND "orgId" = NEW."orgId"
      AND kind = 'TWIN' AND "archivedAt" IS NULL
      AND data->'publicAccess'->>'enabled' = 'true'
      AND data->'widget'->>'enabled' = 'true'
      AND (data->'widget'->'allowedOrigins') ? NEW."embedOrigin"
  ) THEN
    RAISE EXCEPTION 'Widget sessions require an enabled twin and allowed origin';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER widget_session BEFORE INSERT OR UPDATE OF "embedOrigin", "agentId", "orgId"
  ON "InterviewSession" FOR EACH ROW EXECUTE FUNCTION tt_widget_session();

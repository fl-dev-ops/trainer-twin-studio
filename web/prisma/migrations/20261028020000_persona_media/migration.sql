-- Persona = voice + avatar + prompt fields (data) + program settings. Additive only.
-- Voice (exists): reference audio + transcript for cloning. Avatar (new): reference image + video for the
-- AI avatar model. Each persona owns its voice and avatar (unique FKs); both must share the persona's org.

CREATE TABLE "Avatar" (
  "id"         TEXT NOT NULL,
  "orgId"      TEXT,
  "name"       TEXT NOT NULL,
  "s3ImageKey" TEXT,
  "s3VideoKey" TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Avatar_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Avatar_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Avatar_orgId_idx" ON "Avatar"("orgId");

ALTER TABLE "Persona"
  ADD COLUMN "voiceId"  TEXT,
  ADD COLUMN "avatarId" TEXT,
  ADD COLUMN "settings" JSONB;
ALTER TABLE "Persona"
  ADD CONSTRAINT "Persona_voiceId_fkey"  FOREIGN KEY ("voiceId")  REFERENCES "Voice"("id")  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Persona_avatarId_fkey" FOREIGN KEY ("avatarId") REFERENCES "Avatar"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- One persona per voice / avatar: the persona owns them.
CREATE UNIQUE INDEX "Persona_voiceId_key"  ON "Persona"("voiceId");
CREATE UNIQUE INDEX "Persona_avatarId_key" ON "Persona"("avatarId");
ALTER TABLE "Persona" ADD CONSTRAINT "Persona_settings_object" CHECK ("settings" IS NULL OR jsonb_typeof("settings") = 'object');

-- A persona's voice and avatar belong to the same org as the persona (both null for global presets).
CREATE OR REPLACE FUNCTION enforce_persona_media_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."voiceId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Voice" WHERE id = NEW."voiceId" AND "orgId" IS NOT DISTINCT FROM NEW."orgId"
  ) THEN
    RAISE EXCEPTION 'Persona voice must belong to the same organization';
  END IF;
  IF NEW."avatarId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Avatar" WHERE id = NEW."avatarId" AND "orgId" IS NOT DISTINCT FROM NEW."orgId"
  ) THEN
    RAISE EXCEPTION 'Persona avatar must belong to the same organization';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tt_persona_media_org
  BEFORE INSERT OR UPDATE OF "voiceId", "avatarId", "orgId" ON "Persona"
  FOR EACH ROW EXECUTE FUNCTION enforce_persona_media_org();

-- Voice/avatar org cannot move away from the persona that owns them.
CREATE OR REPLACE FUNCTION enforce_persona_media_owner_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."orgId" IS DISTINCT FROM OLD."orgId" AND EXISTS (
    SELECT 1 FROM "Persona" WHERE (TG_TABLE_NAME = 'Voice' AND "voiceId" = NEW.id) OR (TG_TABLE_NAME = 'Avatar' AND "avatarId" = NEW.id)
  ) THEN
    RAISE EXCEPTION '% organization cannot change while a persona owns it', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tt_voice_owner_org BEFORE UPDATE OF "orgId" ON "Voice" FOR EACH ROW EXECUTE FUNCTION enforce_persona_media_owner_org();
CREATE TRIGGER tt_avatar_owner_org BEFORE UPDATE OF "orgId" ON "Avatar" FOR EACH ROW EXECUTE FUNCTION enforce_persona_media_owner_org();

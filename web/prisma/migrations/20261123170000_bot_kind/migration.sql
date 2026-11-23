-- Bots: public agents for signed-out visitors (website widget, public link), split from twins.
-- The enum value is committed here; the next migration uses it.
ALTER TYPE "agent_kind" ADD VALUE IF NOT EXISTS 'BOT';

-- A bot's public channel lives on Deployment (one per agent), next to the role-play API ones.
ALTER TABLE "Deployment" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'api';
ALTER TABLE "Deployment" ADD COLUMN "maxCallSeconds" INTEGER;
ALTER TABLE "Deployment" ADD COLUMN "config" JSONB;
ALTER TABLE "Deployment" ADD CONSTRAINT deployment_channel_check CHECK ("channel" IN ('api', 'public'));
ALTER TABLE "Deployment" ADD CONSTRAINT deployment_public_seconds_check
  CHECK ("channel" <> 'public' OR "maxCallSeconds" IN (300, 600, 900, 1200, 1800));

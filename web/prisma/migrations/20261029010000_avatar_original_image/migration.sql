-- The photo the person took, kept next to the professional headshot generated from it (Avatar.s3ImageKey, shown
-- everywhere). Additive only.
ALTER TABLE "Avatar" ADD COLUMN "s3OriginalImageKey" TEXT;

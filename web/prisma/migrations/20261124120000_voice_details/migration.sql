-- The voice library (like skills): voices keep their id and name; personas point at them. Short details let the persona
-- picker and the copilot choose a voice that fits: gender, age band and accent.
ALTER TABLE "Voice" ADD COLUMN "gender" TEXT;
ALTER TABLE "Voice" ADD COLUMN "age" TEXT;
ALTER TABLE "Voice" ADD COLUMN "accent" TEXT;
ALTER TABLE "Voice" ADD CONSTRAINT "Voice_gender_check" CHECK ("gender" IS NULL OR "gender" IN ('female', 'male'));
ALTER TABLE "Voice" ADD CONSTRAINT "Voice_age_check" CHECK ("age" IS NULL OR "age" IN ('young', 'middle-aged', 'older'));
ALTER TABLE "Voice" ADD CONSTRAINT "Voice_accent_check" CHECK ("accent" IS NULL OR char_length("accent") BETWEEN 1 AND 40);

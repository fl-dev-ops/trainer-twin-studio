-- A voice's home language (the one it sounds native in), as an ISO 639-1 code: the library and the persona picker filter
-- by language first, then accent, gender and age. Existing voices are English.
ALTER TABLE "Voice" ADD COLUMN "language" TEXT NOT NULL DEFAULT 'en';
ALTER TABLE "Voice" ADD CONSTRAINT "Voice_language_check" CHECK ("language" ~ '^[a-z]{2}$');

-- Assignment URLs created during the legacy backfill used 48-bit codes. They
-- have not been distributed yet; rotate them to 72-bit values before use.
UPDATE "InterviewSession"
SET "shareCode" = SUBSTRING(MD5(id || RANDOM()::text) || MD5(RANDOM()::text) FROM 1 FOR 18)
WHERE id LIKE 'assignment\_%' ESCAPE '\';

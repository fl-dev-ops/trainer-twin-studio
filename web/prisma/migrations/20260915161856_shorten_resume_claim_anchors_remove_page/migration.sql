-- Existing claim text is already normalized to one line during extraction.
-- Keep the first six words as the literal PDF text-search anchor.
UPDATE "ResumeClaim"
SET "anchor" = array_to_string(
  (regexp_split_to_array(trim("text"), E'\\s+'))[1:6],
  ' '
);

ALTER TABLE "ResumeClaim" DROP COLUMN "page";

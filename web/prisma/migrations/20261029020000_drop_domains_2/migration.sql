-- Drop domains, phase 2 (plans/drop-domains.md): remove the table, the columns pointing at it and its version history.
-- Phase 1 (drop_domains_1) already moved each domain's rubric onto its agent, and no code reads or writes these.
DELETE FROM "SpecVersion" WHERE "entityType" = 'domains';
ALTER TABLE "Agent" DROP COLUMN "domainSlug";
ALTER TABLE "InterviewSession" DROP COLUMN "domainSlug", DROP COLUMN "domainVersion";
ALTER TABLE "SpecDraft" DROP COLUMN "domainData";
DROP TABLE "Domain";

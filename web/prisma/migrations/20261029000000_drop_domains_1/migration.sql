-- Drop domains, phase 1 (plans/drop-domains.md): the domain's rubric moves onto its agent; domain columns become optional.
-- Additive: nothing is deleted here (phase 2 drops the table and columns).

-- Agents: principles, classifications and knowledge_bases from the agent's domain, where the agent has none of its own.
-- jsonb_build_object yields JSON null for a missing domain key; jsonb_strip_nulls drops those.
UPDATE "Agent" a
SET data = (a.data - 'domain') || jsonb_strip_nulls(jsonb_build_object(
  'principles', CASE WHEN a.data ? 'principles' THEN NULL ELSE d.data -> 'principles' END,
  'classifications', CASE WHEN a.data ? 'classifications' THEN NULL ELSE d.data -> 'classifications' END,
  'knowledge_bases', CASE WHEN a.data ? 'knowledge_bases' THEN NULL ELSE d.data -> 'knowledge_bases' END
))
FROM "Domain" d
WHERE d.slug = a."domainSlug";

-- The agent's pointer to its domain goes, with or without a matching domain row.
UPDATE "Agent" SET data = data - 'domain' WHERE data ? 'domain';

-- Copilot drafts: the same move inside the draft (agentData keeps the rubric; domainData stays until phase 2).
UPDATE "SpecDraft"
SET "agentData" = ("agentData" - 'domain') || jsonb_strip_nulls(jsonb_build_object(
  'principles', CASE WHEN "agentData" ? 'principles' THEN NULL ELSE "domainData" -> 'principles' END,
  'classifications', CASE WHEN "agentData" ? 'classifications' THEN NULL ELSE "domainData" -> 'classifications' END,
  'knowledge_bases', CASE WHEN "agentData" ? 'knowledge_bases' THEN NULL ELSE "domainData" -> 'knowledge_bases' END
))
WHERE jsonb_typeof("domainData") = 'object';

ALTER TABLE "Agent" ALTER COLUMN "domainSlug" DROP NOT NULL;
ALTER TABLE "InterviewSession" ALTER COLUMN "domainSlug" DROP NOT NULL;
ALTER TABLE "InterviewSession" ALTER COLUMN "domainVersion" DROP NOT NULL;
ALTER TABLE "SpecDraft" ALTER COLUMN "domainData" DROP NOT NULL;

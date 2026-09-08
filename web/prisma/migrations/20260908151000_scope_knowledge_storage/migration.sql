DROP INDEX "KnowledgeBase_slug_key";
CREATE UNIQUE INDEX "KnowledgeBase_orgId_slug_key" ON "KnowledgeBase"("orgId", slug);

-- Slug-named Chroma collections are no longer authoritative. The reindex script
-- copies S3 objects and repopulates ID-named collections before marking indexed.
UPDATE "KnowledgeDocument"
SET status = 'uploaded', "indexedAt" = NULL
WHERE status = 'indexed';

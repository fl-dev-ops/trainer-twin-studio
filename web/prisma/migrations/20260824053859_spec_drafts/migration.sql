-- CreateTable
CREATE TABLE "SpecDraft" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "personaSlug" TEXT,
    "agentData" JSONB NOT NULL,
    "domainData" JSONB NOT NULL,
    "groundingData" JSONB NOT NULL,
    "assumptions" JSONB NOT NULL,
    "gaps" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpecDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpecDraftRevision" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpecDraftRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SpecDraft_slug_key" ON "SpecDraft"("slug");

-- CreateIndex
CREATE INDEX "SpecDraftRevision_draftId_idx" ON "SpecDraftRevision"("draftId");

-- CreateIndex
CREATE UNIQUE INDEX "SpecDraftRevision_draftId_revision_key" ON "SpecDraftRevision"("draftId", "revision");

-- AddForeignKey
ALTER TABLE "SpecDraftRevision" ADD CONSTRAINT "SpecDraftRevision_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "SpecDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

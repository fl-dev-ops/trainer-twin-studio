-- CreateTable
CREATE TABLE "PersonaSource" (
    "id" TEXT NOT NULL,
    "personaSlug" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "analysis" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonaSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PersonaSource_personaSlug_idx" ON "PersonaSource"("personaSlug");

-- CreateIndex
CREATE INDEX "PersonaSource_orgId_idx" ON "PersonaSource"("orgId");

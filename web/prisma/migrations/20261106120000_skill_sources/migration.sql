-- Which knowledge base documents each version of a twin skill / role play was built from (items per document).
CREATE TABLE "SkillSource" (
    "agentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "documentId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "items" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillSource_pkey" PRIMARY KEY ("agentId","version","documentId")
);

CREATE INDEX "SkillSource_orgId_documentId_idx" ON "SkillSource"("orgId", "documentId");

ALTER TABLE "SkillSource" ADD CONSTRAINT "SkillSource_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

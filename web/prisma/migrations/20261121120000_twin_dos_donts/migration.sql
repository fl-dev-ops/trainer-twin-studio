-- A twin's Do's & Don'ts per topic: picked once from each skill's playbook (quoted as written), then changed only by the
-- coach. The playbook's wording is kept beside hers; nothing here changes the skill files yet.

-- CreateTable
CREATE TABLE "TwinDoDont" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "skillAgentId" TEXT NOT NULL,
    "skillVersion" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "originalText" TEXT,
    "source" TEXT NOT NULL,
    "editedByUserId" TEXT,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TwinDoDont_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TwinDoDont_agentId_skillAgentId_kind_position_key" ON "TwinDoDont"("agentId", "skillAgentId", "kind", "position");

-- AddForeignKey
ALTER TABLE "TwinDoDont" ADD CONSTRAINT "TwinDoDont_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwinDoDont" ADD CONSTRAINT "TwinDoDont_skillAgentId_fkey" FOREIGN KEY ("skillAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ===== checks =====
ALTER TABLE "TwinDoDont" ADD CONSTRAINT "TwinDoDont_kind_check" CHECK ("kind" IN ('do', 'dont'));
ALTER TABLE "TwinDoDont" ADD CONSTRAINT "TwinDoDont_source_check" CHECK ("source" IN ('playbook', 'edited', 'added'));
ALTER TABLE "TwinDoDont" ADD CONSTRAINT "TwinDoDont_position_check" CHECK ("position" >= 0);

-- CreateTable
CREATE TABLE "RolePlayAssignment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "assignedByUserId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RolePlayAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RolePlayAssignment_orgId_memberId_idx" ON "RolePlayAssignment"("orgId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "RolePlayAssignment_agentId_memberId_key" ON "RolePlayAssignment"("agentId", "memberId");

-- AddForeignKey
ALTER TABLE "RolePlayAssignment" ADD CONSTRAINT "RolePlayAssignment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePlayAssignment" ADD CONSTRAINT "RolePlayAssignment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePlayAssignment" ADD CONSTRAINT "RolePlayAssignment_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

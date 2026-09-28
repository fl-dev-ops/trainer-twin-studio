-- CreateTable
CREATE TABLE "IssueReport" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'bug',
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "url" TEXT,
    "userAgent" TEXT,
    "userId" TEXT,
    "orgId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IssueReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IssueReport_orgId_status_idx" ON "IssueReport"("orgId", "status");

-- CreateIndex
CREATE INDEX "IssueReport_userId_idx" ON "IssueReport"("userId");

-- AddForeignKey
ALTER TABLE "IssueReport" ADD CONSTRAINT "IssueReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueReport" ADD CONSTRAINT "IssueReport_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
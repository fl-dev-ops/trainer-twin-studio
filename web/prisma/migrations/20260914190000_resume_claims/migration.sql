-- CreateTable
CREATE TABLE "ResumeClaim" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "claimNo" INTEGER NOT NULL,
    "section" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "anchor" TEXT NOT NULL,
    "metric" TEXT,
    "page" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResumeClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResumeClaim_documentId_idx" ON "ResumeClaim"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "ResumeClaim_documentId_claimNo_key" ON "ResumeClaim"("documentId", "claimNo");

-- AddForeignKey
ALTER TABLE "ResumeClaim" ADD CONSTRAINT "ResumeClaim_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ContextDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

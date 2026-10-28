-- Twin turn evidence: why a twin said what it said, per brain turn (additive).
CREATE TABLE "TwinTurnEvidence" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TwinTurnEvidence_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TwinTurnEvidence_sessionId_createdAt_idx" ON "TwinTurnEvidence"("sessionId", "createdAt");
ALTER TABLE "TwinTurnEvidence" ADD CONSTRAINT "TwinTurnEvidence_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

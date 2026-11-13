-- API credit grants are deduplicated within an org; existing ledger entries remain unchanged.
ALTER TABLE "MinuteLedger" ADD COLUMN "requestKey" TEXT;
CREATE UNIQUE INDEX "MinuteLedger_orgId_requestKey_key" ON "MinuteLedger"("orgId", "requestKey");

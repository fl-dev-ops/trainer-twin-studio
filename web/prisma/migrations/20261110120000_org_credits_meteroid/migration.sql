-- Org credits move to Meteroid (plans: phase 1). The org's balance is Meteroid's; the app keeps learners' minutes, and
-- sends Meteroid what spends the org's credits: minutes given to learners (grant rows) and admin/team voice calls
-- (org_usage rows), one usage event per row (event id = row id). topup/refund rows stay as history; nothing new adds them.
-- CHECKs are not tracked by Prisma; they live only here.

ALTER TABLE "MinuteLedger" ADD COLUMN "meteroidSentAt" TIMESTAMP(3);
-- Minutes given before Meteroid were paid from the old balance, which Meteroid's starting grants replace: never send them.
UPDATE "MinuteLedger" SET "meteroidSentAt" = "createdAt" WHERE "type" = 'grant';
CREATE INDEX "MinuteLedger_orgId_meteroidSentAt_idx" ON "MinuteLedger"("orgId", "meteroidSentAt") WHERE "type" IN ('grant', 'org_usage');

ALTER TABLE "MinuteLedger" DROP CONSTRAINT "MinuteLedger_type_check";
ALTER TABLE "MinuteLedger" ADD CONSTRAINT "MinuteLedger_type_check" CHECK ("type" IN ('topup', 'refund', 'grant', 'reclaim', 'usage', 'org_usage'));
ALTER TABLE "MinuteLedger" DROP CONSTRAINT "MinuteLedger_sign_check";
ALTER TABLE "MinuteLedger" ADD CONSTRAINT "MinuteLedger_sign_check" CHECK (
    ("type" IN ('topup', 'grant') AND "seconds" > 0)
    OR ("type" IN ('refund', 'reclaim') AND "seconds" < 0)
    OR ("type" IN ('usage', 'org_usage') AND "seconds" <= 0)
);
ALTER TABLE "MinuteLedger" DROP CONSTRAINT "MinuteLedger_usage_session_check";
ALTER TABLE "MinuteLedger" ADD CONSTRAINT "MinuteLedger_usage_session_check" CHECK (("type" IN ('usage', 'org_usage')) = ("sessionId" IS NOT NULL));

ALTER TABLE "InterviewSession" ADD COLUMN "chargesOrg" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "OrgBilling" (
    "orgId" TEXT NOT NULL,
    "meteroidCustomerId" TEXT NOT NULL,
    "balanceMinutes" INTEGER NOT NULL DEFAULT 0,
    "balanceAsOf" TIMESTAMP(3),
    "grants" JSONB NOT NULL DEFAULT '[]',
    "syncedAt" TIMESTAMP(3),
    CONSTRAINT "OrgBilling_pkey" PRIMARY KEY ("orgId")
);
CREATE UNIQUE INDEX "OrgBilling_meteroidCustomerId_key" ON "OrgBilling"("meteroidCustomerId");
ALTER TABLE "OrgBilling" ADD CONSTRAINT "OrgBilling_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

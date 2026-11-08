-- Prepaid practice minutes (plans: platform-wide learner minutes). One ledger per org: TrainerTwin tops the org up,
-- the org gives learners minutes from it, learner calls (twin and role play) use them. Seconds throughout.
-- CHECKs are not tracked by Prisma; they live only here.

-- AlterTable
ALTER TABLE "InterviewSession" ADD COLUMN "allowedSeconds" INTEGER;

-- CreateTable
CREATE TABLE "MinuteLedger" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "seconds" INTEGER NOT NULL,
    "sessionId" TEXT,
    "actorUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MinuteLedger_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MinuteLedger_type_check" CHECK ("type" IN ('topup', 'grant', 'reclaim', 'usage')),
    CONSTRAINT "MinuteLedger_sign_check" CHECK (
        ("type" IN ('topup', 'grant') AND "seconds" > 0)
        OR ("type" = 'reclaim' AND "seconds" < 0)
        OR ("type" = 'usage' AND "seconds" <= 0)
    ),
    -- Top-ups belong to the org; every other movement to one learner. Usage rows name their session.
    CONSTRAINT "MinuteLedger_holder_check" CHECK (("type" = 'topup') = ("email" IS NULL)),
    CONSTRAINT "MinuteLedger_email_lower_check" CHECK ("email" IS NULL OR "email" = lower("email")),
    CONSTRAINT "MinuteLedger_usage_session_check" CHECK (("type" = 'usage') = ("sessionId" IS NOT NULL))
);

ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_allowed_seconds_check" CHECK ("allowedSeconds" IS NULL OR "allowedSeconds" > 0);

-- CreateIndex
CREATE UNIQUE INDEX "MinuteLedger_sessionId_key" ON "MinuteLedger"("sessionId");

-- CreateIndex
CREATE INDEX "MinuteLedger_orgId_email_idx" ON "MinuteLedger"("orgId", "email");

-- CreateIndex
CREATE INDEX "MinuteLedger_orgId_type_idx" ON "MinuteLedger"("orgId", "type");

-- AddForeignKey
ALTER TABLE "MinuteLedger" ADD CONSTRAINT "MinuteLedger_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

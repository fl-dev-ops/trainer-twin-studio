-- Credits bought through Razorpay (plans: payments). A paid purchase adds a topup row naming its payment; a refund
-- adds a refund row (negative, the org's own) naming the Razorpay refund. externalId makes each of them happen once.
-- CHECKs are not tracked by Prisma; they live only here.

-- AlterTable
ALTER TABLE "MinuteLedger" ADD COLUMN "externalId" TEXT;
CREATE UNIQUE INDEX "MinuteLedger_externalId_key" ON "MinuteLedger"("externalId");

ALTER TABLE "MinuteLedger" DROP CONSTRAINT "MinuteLedger_type_check";
ALTER TABLE "MinuteLedger" ADD CONSTRAINT "MinuteLedger_type_check" CHECK ("type" IN ('topup', 'refund', 'grant', 'reclaim', 'usage'));
ALTER TABLE "MinuteLedger" DROP CONSTRAINT "MinuteLedger_sign_check";
ALTER TABLE "MinuteLedger" ADD CONSTRAINT "MinuteLedger_sign_check" CHECK (
    ("type" IN ('topup', 'grant') AND "seconds" > 0)
    OR ("type" IN ('refund', 'reclaim') AND "seconds" < 0)
    OR ("type" = 'usage' AND "seconds" <= 0)
);
-- Top-ups and refunds belong to the org; every other movement to one learner.
ALTER TABLE "MinuteLedger" DROP CONSTRAINT "MinuteLedger_holder_check";
ALTER TABLE "MinuteLedger" ADD CONSTRAINT "MinuteLedger_holder_check" CHECK (("type" IN ('topup', 'refund')) = ("email" IS NULL));
ALTER TABLE "MinuteLedger" ADD CONSTRAINT "MinuteLedger_refund_external_check" CHECK ("type" <> 'refund' OR "externalId" IS NOT NULL);

-- CreateTable
CREATE TABLE "CreditPurchase" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "razorpayId" TEXT,
    "paymentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'created',
    "refundedAmount" INTEGER NOT NULL DEFAULT 0,
    "url" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "CreditPurchase_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CreditPurchase_credits_check" CHECK ("credits" > 0),
    CONSTRAINT "CreditPurchase_amount_check" CHECK ("amount" > 0),
    CONSTRAINT "CreditPurchase_currency_check" CHECK ("currency" IN ('INR', 'USD')),
    CONSTRAINT "CreditPurchase_kind_check" CHECK ("kind" IN ('payment_link', 'invoice')),
    CONSTRAINT "CreditPurchase_status_check" CHECK ("status" IN ('created', 'paid', 'partially_refunded', 'refunded')),
    CONSTRAINT "CreditPurchase_refunded_check" CHECK ("refundedAmount" >= 0 AND "refundedAmount" <= "amount")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditPurchase_razorpayId_key" ON "CreditPurchase"("razorpayId");
CREATE UNIQUE INDEX "CreditPurchase_paymentId_key" ON "CreditPurchase"("paymentId");
CREATE INDEX "CreditPurchase_orgId_idx" ON "CreditPurchase"("orgId");

-- AddForeignKey
ALTER TABLE "CreditPurchase" ADD CONSTRAINT "CreditPurchase_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

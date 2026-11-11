-- Billing phase 3 (specs/billing.md rules 27–35): each invoice's Razorpay payment link and the payment that settled it,
-- and every Razorpay payment for an invoice (applied or a duplicate to refund) with its fee. Additive.

BEGIN;

ALTER TABLE "BillingInvoice"
  ADD COLUMN "paymentLinkId" TEXT,
  ADD COLUMN "paymentLinkUrl" TEXT,
  ADD COLUMN "razorpayPaymentId" TEXT;
CREATE UNIQUE INDEX "BillingInvoice_paymentLinkId_key" ON "BillingInvoice"("paymentLinkId");
CREATE UNIQUE INDEX "BillingInvoice_razorpayPaymentId_key" ON "BillingInvoice"("razorpayPaymentId");

CREATE TABLE "BillingPayment" (
  "id" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "paymentLinkId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "amountInr" INTEGER,
  "feeInr" INTEGER,
  "taxInr" INTEGER,
  "method" TEXT,
  "international" BOOLEAN,
  "paidAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingPayment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BillingPayment_status_check" CHECK ("status" IN ('applied', 'duplicate')),
  CONSTRAINT "BillingPayment_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "BillingPayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "BillingInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "BillingPayment_orgId_paidAt_idx" ON "BillingPayment"("orgId", "paidAt");
CREATE INDEX "BillingPayment_paidAt_idx" ON "BillingPayment"("paidAt");

COMMIT;

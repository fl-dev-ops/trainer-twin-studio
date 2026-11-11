-- Billing phase 2 (specs/billing.md): each billed org's plan (trial | paid), its Paid subscription, custom price,
-- pause and billing details; and the app's copy of each Meteroid invoice above $0. Every existing billed org starts on
-- Trial (rule 1): nothing to backfill.

BEGIN;

ALTER TABLE "OrgBilling"
  ADD COLUMN "plan" TEXT NOT NULL DEFAULT 'trial',
  ADD COLUMN "paidSubscriptionId" TEXT,
  ADD COLUMN "paidMonthlyCents" INTEGER,
  ADD COLUMN "pausedAt" TIMESTAMP(3),
  ADD COLUMN "billingDetails" JSONB,
  ADD CONSTRAINT "OrgBilling_plan_check" CHECK ("plan" IN ('trial', 'paid')),
  ADD CONSTRAINT "OrgBilling_paidMonthlyCents_check" CHECK ("paidMonthlyCents" IS NULL OR "paidMonthlyCents" > 0),
  -- Only a Paid org can be paused (rule 15).
  ADD CONSTRAINT "OrgBilling_paused_check" CHECK ("pausedAt" IS NULL OR "plan" = 'paid');
CREATE UNIQUE INDEX "OrgBilling_paidSubscriptionId_key" ON "OrgBilling"("paidSubscriptionId");

CREATE TABLE "BillingInvoice" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'unpaid',
  "totalCents" INTEGER NOT NULL,
  "taxCents" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL,
  "subscriptionId" TEXT,
  "credits" INTEGER NOT NULL DEFAULT 0,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "dueDate" DATE NOT NULL,
  "periodStart" DATE,
  "periodEnd" DATE,
  "paidAt" TIMESTAMP(3),
  "paymentRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "issuedRunAt" TIMESTAMP(3),
  "paidRunAt" TIMESTAMP(3),
  "issuedEmailAt" TIMESTAMP(3),
  "reminderAt" TIMESTAMP(3),
  "overdueAt" TIMESTAMP(3),
  "overdueEmailAt" TIMESTAMP(3),
  "paidEmailAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingInvoice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BillingInvoice_kind_check" CHECK ("kind" IN ('upgrade', 'renewal', 'pack', 'other')),
  CONSTRAINT "BillingInvoice_status_check" CHECK ("status" IN ('unpaid', 'paid', 'void')),
  -- Rule 23: $0 invoices are never stored.
  CONSTRAINT "BillingInvoice_total_check" CHECK ("totalCents" > 0),
  CONSTRAINT "BillingInvoice_credits_check" CHECK ("credits" >= 0),
  CONSTRAINT "BillingInvoice_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "OrgBilling"("orgId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "BillingInvoice_orgId_issuedAt_idx" ON "BillingInvoice"("orgId", "issuedAt");
CREATE INDEX "BillingInvoice_status_dueDate_idx" ON "BillingInvoice"("status", "dueDate");

COMMIT;

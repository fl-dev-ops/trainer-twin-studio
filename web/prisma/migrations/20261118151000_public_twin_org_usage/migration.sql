ALTER TABLE "MinuteLedger" DROP CONSTRAINT "MinuteLedger_holder_check";
ALTER TABLE "MinuteLedger" ADD CONSTRAINT "MinuteLedger_holder_check" CHECK (
  CASE
    WHEN "type" IN ('topup', 'refund') THEN "email" IS NULL
    WHEN "type" = 'org_usage' THEN TRUE
    ELSE "email" IS NOT NULL
  END
);

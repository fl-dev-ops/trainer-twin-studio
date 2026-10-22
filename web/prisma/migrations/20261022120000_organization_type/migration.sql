-- Organization type: SALES orgs build role plays, TECHNICAL_INTERVIEW orgs build
-- interview scenarios. Existing orgs are interview orgs.
CREATE TYPE "org_type" AS ENUM ('SALES', 'TECHNICAL_INTERVIEW');

ALTER TABLE "organization" ADD COLUMN "type" "org_type" NOT NULL DEFAULT 'TECHNICAL_INTERVIEW';

ALTER TABLE "founder_invite" ADD COLUMN "orgType" "org_type" NOT NULL DEFAULT 'TECHNICAL_INTERVIEW';

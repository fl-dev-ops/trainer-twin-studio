-- Host-delegated authentication: org-level auth mode + host JWKS config,
-- and host-external user identity on members.

-- CreateEnum
CREATE TYPE "AuthMode" AS ENUM ('HOST_DELEGATED', 'BUILTIN');

-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "authMode" "AuthMode" NOT NULL DEFAULT 'BUILTIN',
ADD COLUMN     "hostJwks" JSONB,
ADD COLUMN     "hostIssuer" TEXT,
ADD COLUMN     "hostAudience" TEXT,
ADD COLUMN     "hostRoleMapping" JSONB;

-- AlterTable
ALTER TABLE "member" ADD COLUMN     "externalUserId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "member_organizationId_externalUserId_key" ON "member"("organizationId", "externalUserId");

-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "chromaDatabase" TEXT NOT NULL DEFAULT 'default',
ADD COLUMN     "chromaTenantId" TEXT;

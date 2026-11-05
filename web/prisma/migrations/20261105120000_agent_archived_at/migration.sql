-- Soft delete for twins, twin skills and role plays (copilot archive / restore).
ALTER TABLE "Agent" ADD COLUMN "archivedAt" TIMESTAMP(3);

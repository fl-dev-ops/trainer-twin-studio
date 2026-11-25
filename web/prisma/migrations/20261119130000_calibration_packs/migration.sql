-- Calibration packs: a coach's set of calibration questions for a twin (10 questions, each with its follow-up), kept
-- open across visits until every answer is marked. A pack's cards belong to the pack, not to one visit; each answer
-- (TwinCalibrationRating) still records the visit it was given in. Cards asked within one visit (before packs) keep
-- their calibration. CHECKs and indexes Prisma doesn't track live only here.

-- AlterTable
ALTER TABLE "TwinCalibrationCard" ADD COLUMN     "packId" TEXT,
ALTER COLUMN "calibrationId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "TwinCalibrationPack" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "TwinCalibrationPack_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TwinCalibrationPack_agentId_createdByUserId_status_idx" ON "TwinCalibrationPack"("agentId", "createdByUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TwinCalibrationCard_packId_position_key" ON "TwinCalibrationCard"("packId", "position");

-- AddForeignKey
ALTER TABLE "TwinCalibrationCard" ADD CONSTRAINT "TwinCalibrationCard_packId_fkey" FOREIGN KEY ("packId") REFERENCES "TwinCalibrationPack"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwinCalibrationPack" ADD CONSTRAINT "TwinCalibrationPack_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ===== checks =====
ALTER TABLE "TwinCalibrationPack" ADD CONSTRAINT "TwinCalibrationPack_status_check" CHECK ("status" IN ('open', 'complete'));
ALTER TABLE "TwinCalibrationCard" ADD CONSTRAINT "TwinCalibrationCard_owner_check" CHECK ("packId" IS NOT NULL OR "calibrationId" IS NOT NULL);

-- ===== one open pack per coach per twin =====
CREATE UNIQUE INDEX "TwinCalibrationPack_one_open" ON "TwinCalibrationPack"("agentId", "createdByUserId") WHERE "status" = 'open';

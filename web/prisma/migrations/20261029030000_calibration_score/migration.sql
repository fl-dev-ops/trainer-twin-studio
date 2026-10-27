-- Jev's turn count and meant "Feels off" count for a calibration (null until scored).
ALTER TABLE "TwinCalibration" ADD COLUMN "turns" INTEGER,
ADD COLUMN "offTurns" INTEGER,
ADD COLUMN "scoredAt" TIMESTAMP(3);

-- specs/practice.md rule 14: scoring is claimed before the model is called (one paid call per calibration).
ALTER TABLE "TwinCalibration" ADD COLUMN "scoreClaimedAt" TIMESTAMP(3);

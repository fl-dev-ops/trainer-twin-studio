-- Twin calibration (plans/twin-roleplay-db-split.md §14). A calibration is a studio member's call with a twin
-- (a normal InterviewSession, 1:1) plus their ratings of the twin's replies. CHECKs and triggers are not
-- tracked by Prisma; they live only here.

-- CreateTable
CREATE TABLE "TwinCalibration" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TwinCalibration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TwinCalibrationRating" (
    "id" TEXT NOT NULL,
    "calibrationId" TEXT NOT NULL,
    "turnIndex" INTEGER NOT NULL,
    "question" TEXT,
    "reply" TEXT NOT NULL,
    "rating" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TwinCalibrationRating_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TwinCalibration_sessionId_key" ON "TwinCalibration"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "TwinCalibrationRating_calibrationId_turnIndex_key" ON "TwinCalibrationRating"("calibrationId", "turnIndex");

-- AddForeignKey
ALTER TABLE "TwinCalibration" ADD CONSTRAINT "TwinCalibration_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwinCalibrationRating" ADD CONSTRAINT "TwinCalibrationRating_calibrationId_fkey" FOREIGN KEY ("calibrationId") REFERENCES "TwinCalibration"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===== checks =====
ALTER TABLE "TwinCalibrationRating" ADD CONSTRAINT "TwinCalibrationRating_rating_check" CHECK ("rating" IN ('like', 'off'));
ALTER TABLE "TwinCalibrationRating" ADD CONSTRAINT "TwinCalibrationRating_turnIndex_check" CHECK ("turnIndex" >= 0);

-- ===== a calibration is always a twin session =====
CREATE FUNCTION tt_twin_calibration_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "InterviewSession" s JOIN "Agent" a ON a.id = s."agentId"
    WHERE s.id = NEW."sessionId" AND a.kind = 'TWIN'
  ) THEN
    RAISE EXCEPTION 'A calibration must be a twin session';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER twin_calibration_session BEFORE INSERT OR UPDATE OF "sessionId" ON "TwinCalibration"
  FOR EACH ROW EXECUTE FUNCTION tt_twin_calibration_session();

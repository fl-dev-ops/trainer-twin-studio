-- Calibration v2: card calibrations (questions → cards → rated replies). The coach asks a twin text questions, one
-- card at a time, and marks each reply; "Feels off" keeps her reasons and her own answer (text, and audio when spoken).
-- Generated questions are kept per twin. Voice-call calibrations are unchanged: their ratings leave the new columns empty.
-- CHECKs and triggers are not tracked by Prisma; they live only here.

-- AlterTable
ALTER TABLE "TwinCalibrationRating" ADD COLUMN     "cardId" TEXT,
ADD COLUMN     "correction" TEXT,
ADD COLUMN     "correctionAudioKey" TEXT,
ADD COLUMN     "correctionInput" TEXT,
ADD COLUMN     "learnerSource" TEXT,
ADD COLUMN     "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "TwinCalibrationQuestion" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "skillAgentId" TEXT,
    "topic" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "askedAt" TIMESTAMP(3),

    CONSTRAINT "TwinCalibrationQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TwinCalibrationCard" (
    "id" TEXT NOT NULL,
    "calibrationId" TEXT NOT NULL,
    "questionId" TEXT,
    "position" INTEGER NOT NULL,
    "topic" TEXT NOT NULL,
    "agentVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TwinCalibrationCard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TwinCalibrationQuestion_agentId_status_idx" ON "TwinCalibrationQuestion"("agentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TwinCalibrationCard_calibrationId_position_key" ON "TwinCalibrationCard"("calibrationId", "position");

-- CreateIndex
CREATE INDEX "TwinCalibrationRating_cardId_idx" ON "TwinCalibrationRating"("cardId");

-- AddForeignKey
ALTER TABLE "TwinCalibrationRating" ADD CONSTRAINT "TwinCalibrationRating_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "TwinCalibrationCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwinCalibrationQuestion" ADD CONSTRAINT "TwinCalibrationQuestion_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwinCalibrationQuestion" ADD CONSTRAINT "TwinCalibrationQuestion_skillAgentId_fkey" FOREIGN KEY ("skillAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwinCalibrationCard" ADD CONSTRAINT "TwinCalibrationCard_calibrationId_fkey" FOREIGN KEY ("calibrationId") REFERENCES "TwinCalibration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwinCalibrationCard" ADD CONSTRAINT "TwinCalibrationCard_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "TwinCalibrationQuestion"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- ===== checks =====
ALTER TABLE "TwinCalibrationRating" ADD CONSTRAINT "TwinCalibrationRating_learnerSource_check" CHECK ("learnerSource" IN ('suggested', 'edited', 'own'));
ALTER TABLE "TwinCalibrationRating" ADD CONSTRAINT "TwinCalibrationRating_correctionInput_check" CHECK ("correctionInput" IN ('typed', 'voice'));
ALTER TABLE "TwinCalibrationQuestion" ADD CONSTRAINT "TwinCalibrationQuestion_origin_check" CHECK ("origin" IN ('generated', 'own'));
ALTER TABLE "TwinCalibrationQuestion" ADD CONSTRAINT "TwinCalibrationQuestion_status_check" CHECK ("status" IN ('new', 'asked', 'skipped'));
ALTER TABLE "TwinCalibrationCard" ADD CONSTRAINT "TwinCalibrationCard_position_check" CHECK ("position" >= 0);

-- ===== twin sessions: voice only, except calibrations =====
-- A calibration's session and its TwinCalibration row are created in one transaction (lib/interview-sessions.ts), so
-- the mode check waits for commit, when the calibration row exists. The assignment check stays immediate.
CREATE OR REPLACE FUNCTION tt_twin_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT kind FROM "Agent" WHERE id = NEW."agentId") = 'TWIN' THEN
    IF NEW."twinAssignmentId" IS NULL AND NOT EXISTS (
      SELECT 1 FROM "member" WHERE "userId" = NEW."userId" AND "organizationId" = NEW."orgId"
        AND "role" IN ('admin', 'team')) THEN
      RAISE EXCEPTION 'Twin sessions need a twin assignment unless the user is admin or team';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION tt_twin_session_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."mode" <> 'voice'
    AND (SELECT kind FROM "Agent" WHERE id = NEW."agentId") = 'TWIN'
    AND NOT EXISTS (SELECT 1 FROM "TwinCalibration" WHERE "sessionId" = NEW.id) THEN
    RAISE EXCEPTION 'Twin sessions are voice only (calibrations may be text)';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER twin_session_mode AFTER INSERT OR UPDATE OF "agentId", "mode" ON "InterviewSession"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION tt_twin_session_mode();

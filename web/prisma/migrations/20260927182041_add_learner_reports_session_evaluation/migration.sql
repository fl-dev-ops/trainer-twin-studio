-- AlterTable
ALTER TABLE "Deployment" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "InterviewSession" ADD COLUMN     "attempt" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "report" JSONB,
ADD COLUMN     "reportStatus" TEXT DEFAULT 'none';

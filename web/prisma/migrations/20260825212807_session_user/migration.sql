/*
  Warnings:

  - You are about to drop the column `learnerId` on the `InterviewSession` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "InterviewSession" DROP COLUMN "learnerId",
ADD COLUMN     "userId" TEXT;

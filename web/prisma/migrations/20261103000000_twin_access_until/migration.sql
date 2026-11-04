-- Twin access end date (additive): the last moment a learner can start a call on this assignment; null = no end date.
ALTER TABLE "TwinAssignment" ADD COLUMN "accessUntil" TIMESTAMP(3);

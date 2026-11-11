-- specs/practice.md rule 24: when a call's end work was started, so the sweep can retry the ones that never started.
ALTER TABLE "InterviewSession" ADD COLUMN "endWorkAt" TIMESTAMP(3);
-- Calls that ended before this rule are left as they are (their end work isn't retried).
UPDATE "InterviewSession" SET "endWorkAt" = "endedAt" WHERE "endedAt" IS NOT NULL;

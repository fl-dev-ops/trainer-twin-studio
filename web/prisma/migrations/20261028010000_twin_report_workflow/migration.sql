-- Twin session reports run as a Vercel Workflow; the run id is kept for dedupe and status checks.
ALTER TABLE "InterviewSession" ADD COLUMN "reportWorkflowRunId" TEXT;

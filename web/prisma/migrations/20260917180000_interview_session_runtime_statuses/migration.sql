ALTER TABLE "InterviewSession" DROP CONSTRAINT IF EXISTS "InterviewSession_status_check";
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_status_check"
  CHECK (status IN ('assigned', 'activating', 'active', 'closing', 'completed', 'abandoned', 'revoked', 'failed'));

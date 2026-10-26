CREATE TABLE "copilot_session" (
  "sessionId" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" VARCHAR(120) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "copilot_session_pkey" PRIMARY KEY ("sessionId")
);

CREATE INDEX "copilot_session_orgId_userId_createdAt_idx" ON "copilot_session"("orgId", "userId", "createdAt");

ALTER TABLE "copilot_session" ADD CONSTRAINT "copilot_session_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "copilot_session" ADD CONSTRAINT "copilot_session_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Validate that existing Topic statuses only contain allowed enum values before conversion
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Topic"
    WHERE "status" NOT IN ('proposed', 'approved')
  ) THEN
    RAISE EXCEPTION 'Topic table contains invalid status values outside proposed/approved';
  END IF;
END $$;

-- CreateEnum
CREATE TYPE "TopicStatus" AS ENUM ('proposed', 'approved');

-- AlterTable
ALTER TABLE "Topic" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Topic" ALTER COLUMN "status" TYPE "TopicStatus" USING ("status"::"TopicStatus");
ALTER TABLE "Topic" ALTER COLUMN "status" SET DEFAULT 'approved';

-- AlterTable
ALTER TABLE "KnowledgeDocument" ALTER COLUMN "s3MarkdownKey" DROP NOT NULL;
ALTER TABLE "KnowledgeDocument" ADD COLUMN "s3QuestionsKey" TEXT;

/*
  Warnings:

  - You are about to drop the column `content` on the `KnowledgeDocument` table. All the data in the column will be lost.
  - Added the required column `ext` to the `KnowledgeDocument` table without a default value. This is not possible if the table is not empty.
  - Added the required column `s3MarkdownKey` to the `KnowledgeDocument` table without a default value. This is not possible if the table is not empty.
  - Added the required column `s3SourceKey` to the `KnowledgeDocument` table without a default value. This is not possible if the table is not empty.
  - Added the required column `size` to the `KnowledgeDocument` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "KnowledgeDocument" DROP COLUMN "content",
ADD COLUMN     "error" TEXT,
ADD COLUMN     "ext" TEXT NOT NULL,
ADD COLUMN     "indexedAt" TIMESTAMP(3),
ADD COLUMN     "s3MarkdownKey" TEXT NOT NULL,
ADD COLUMN     "s3SourceKey" TEXT NOT NULL,
ADD COLUMN     "size" INTEGER NOT NULL,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'uploaded';

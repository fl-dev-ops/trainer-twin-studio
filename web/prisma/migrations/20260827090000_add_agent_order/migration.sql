/*
  Warnings:
  - Added the required column `order` to the `Agent` table with a default value.
    The default value will be added during the migration.
*/

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN "order" INTEGER NOT NULL DEFAULT 0;

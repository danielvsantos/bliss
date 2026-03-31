-- AlterTable
ALTER TABLE "StagedImport" ADD COLUMN     "autoConfirmedCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "autoPromoteThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.95,
ADD COLUMN     "reviewThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.70;

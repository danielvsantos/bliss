-- AlterTable
ALTER TABLE "StagedImport" ADD COLUMN     "progress" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "StagedImportRow" ADD COLUMN     "details" TEXT;

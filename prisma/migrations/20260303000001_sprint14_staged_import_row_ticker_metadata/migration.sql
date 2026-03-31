-- AlterTable: Add ticker resolution metadata to StagedImportRow (Sprint 14)
ALTER TABLE "StagedImportRow" ADD COLUMN "isin" TEXT;
ALTER TABLE "StagedImportRow" ADD COLUMN "exchange" TEXT;
ALTER TABLE "StagedImportRow" ADD COLUMN "assetCurrency" TEXT;

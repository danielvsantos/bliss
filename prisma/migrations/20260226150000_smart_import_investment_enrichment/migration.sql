-- Sprint 12.8b: Smart Import Investment Enrichment (parity with PlaidTransaction)
-- Adds investment enrichment fields to StagedImportRow

ALTER TABLE "StagedImportRow" ADD COLUMN "requiresEnrichment" BOOLEAN DEFAULT false;
ALTER TABLE "StagedImportRow" ADD COLUMN "enrichmentType" TEXT;
ALTER TABLE "StagedImportRow" ADD COLUMN "ticker" TEXT;
ALTER TABLE "StagedImportRow" ADD COLUMN "assetQuantity" DECIMAL(18,8);
ALTER TABLE "StagedImportRow" ADD COLUMN "assetPrice" DECIMAL(18,8);
